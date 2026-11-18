/**
 * Estrazione di una pagina PDF per il motore di layout Rust (`analyze_pdf_layout`).
 * Portato da PDF X-Ray (`src/extract.js`).
 *
 * Tutto è in punti PDF (viewport a scala 1, origine in alto a sinistra, y verso
 * il basso), quindi l'analisi non dipende dallo zoom. Per ogni run di testo si
 * registrano anche le informazioni del Tagged PDF (MCID, /Artifact, elemento
 * di struttura e suo ruolo); dall'operator list si ricavano rettangoli
 * vettoriali e immagini, seguendo la CTM.
 */


// Structure elements that own a translation unit. Inside "locking" elements
// (list items, table cells, captions, notes) nested blocks are merged.
const BLOCK_ROLES = new Set([
  'P', 'H', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'Title', 'Caption', 'Note', 'FENote',
  'LI', 'TD', 'TH', 'BlockQuote', 'TOCI', 'Figure', 'Formula', 'Code',
]);
const LOCKING_ROLES = new Set(['LI', 'TD', 'TH', 'Caption', 'Note', 'FENote', 'TOCI', 'Figure', 'Formula']);

// pdf.js >= 5 path encoding inside OPS.constructPath
const DRAW = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 };

/** Extract one page. Returns { page, viewport, data, tagged }. */
export async function extractPage(pdfDoc, pageNum) {
  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1 });

  // The operator list also loads the fonts into commonObjs (real font names).
  const graphics = await extractGraphics(page, viewport);
  const structMap = await extractStructure(page);
  const textContent = await page.getTextContent({ includeMarkedContent: true });

  const items = [];
  const stack = [];
  for (const it of textContent.items) {
    if (it.type === 'beginMarkedContent' || it.type === 'beginMarkedContentProps') {
      stack.push({ tag: it.tag || null, id: it.id || null });
      continue;
    }
    if (it.type === 'endMarkedContent') {
      stack.pop();
      continue;
    }
    if (!it.transform || typeof it.str !== 'string' || it.str.trim().length === 0) continue;

    const style = textContent.styles[it.fontName] || {};
    const box = itemBox(it, style, viewport);
    if (!box) continue;

    let mcid = null;
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k].id) { mcid = stack[k].id; break; }
    }
    const st = mcid ? structMap.get(mcid) : null;
    items.push({
      text: it.str,
      x: box.x,
      y: box.y,
      width: box.w,
      height: box.h,
      font_size: box.fs,
      font_name: fontName(page, it.fontName, style),
      mcid,
      artifact: stack.some(s => s.tag === 'Artifact'),
      struct_id: st ? st.id : null,
      struct_role: st ? st.role : null,
    });
  }

  return {
    page,
    viewport,
    tagged: structMap.size > 0,
    data: {
      pageNum,
      pageBounds: { x: 0, y: 0, w: viewport.width, h: viewport.height },
      items,
      borderedBoxes: graphics.rects,
      images: graphics.images,
    },
  };
}

/** Axis-aligned bounding box of a (possibly rotated) text run, in viewport points. */
function itemBox(it, style, viewport) {
  const [a, b, c, d, e, f] = it.transform;
  const dl = Math.hypot(a, b);
  const ul = Math.hypot(c, d);
  const fs = ul || dl;
  if (!fs || !isFinite(fs)) return null;
  const dx = dl ? a / dl : 1, dy = dl ? b / dl : 0;
  const ux = ul ? c / ul : 0, uy = ul ? d / ul : 1;

  let asc = typeof style.ascent === 'number' ? style.ascent : 0.8;
  let desc = typeof style.descent === 'number' ? style.descent : -0.2;
  if (desc > 0) desc = -desc;
  if (asc - desc < 0.5 || asc - desc > 2.5) { asc = 0.8; desc = -0.2; }

  const len = style.vertical ? (it.height || it.width) : it.width;
  const pts = [];
  for (const t of [0, len]) {
    for (const u of [desc * fs, asc * fs]) {
      const [px, py] = viewport.convertToViewportPoint(e + dx * t + ux * u, f + dy * t + uy * u);
      pts.push(px, py);
    }
  }
  const xs = pts.filter((_, i) => i % 2 === 0);
  const ys = pts.filter((_, i) => i % 2 === 1);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  // font size in viewport space (scale 1 → points), independent of rotation
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, fs: fs * Math.hypot(viewport.transform[0], viewport.transform[1]) };
}

function fontName(page, id, style) {
  try {
    if (id && page.commonObjs.has(id)) {
      const f = page.commonObjs.get(id);
      let name = f && f.name ? String(f.name) : null;
      if (name) {
        // make weight visible to the name-based heuristics when only flags carry it
        if ((f.bold || f.black) && !/bold|black|heavy|semibold|demi/i.test(name)) name += ',Bold';
        if (f.italic && !/italic|oblique/i.test(name)) name += ',Italic';
        return name;
      }
    }
  } catch (_) { /* font not resolved yet */ }
  return style.fontFamily ? `${style.fontFamily}#${id}` : id || null;
}

/** Map marked-content id → { id: block index in tree order, role }. */
async function extractStructure(page) {
  const map = new Map();
  let tree = null;
  try {
    tree = await page.getStructTree();
  } catch (_) {
    return map;
  }
  if (!tree) return map;
  let counter = 0;
  const walk = (node, owner) => {
    if (!node) return;
    if (node.type === 'content') {
      if (node.id && owner) map.set(node.id, owner);
      return;
    }
    if (node.type) return; // object / annotation references
    let cur = owner;
    if (!(owner && owner.locked) && node.role && BLOCK_ROLES.has(node.role)) {
      cur = { id: counter++, role: node.role, locked: LOCKING_ROLES.has(node.role) };
    }
    for (const ch of node.children || []) walk(ch, cur);
  };
  walk(tree, null);
  return new Map([...map].map(([k, v]) => [k, { id: v.id, role: v.role }]));
}

const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function bboxOf(points, viewport) {
  const vp = points.map(([x, y]) => viewport.convertToViewportPoint(x, y));
  const xs = vp.map(p => p[0]), ys = vp.map(p => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Vector rectangles (stroked or filled) and placed images, CTM-aware. */
export async function extractGraphics(page, viewport) {
  const { OPS } = await import('pdfjs-dist');
  const rects = [];
  const images = [];
  let opList;
  try {
    opList = await page.getOperatorList();
  } catch (err) {
    console.warn('Operator list unavailable:', err);
    return { rects, images };
  }
  const paintOps = new Set([
    OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke,
    OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke,
  ].filter(v => v !== undefined));
  const imageOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject].filter(v => v !== undefined));

  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const { fnArray, argsArray } = opList;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (fn === OPS.save) {
      stack.push(ctm);
    } else if (fn === OPS.restore) {
      ctm = stack.pop() || ctm;
    } else if (fn === OPS.transform) {
      ctm = mul(ctm, args);
    } else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (Array.isArray(args?.[0]) || ArrayBuffer.isView(args?.[0])) ctm = mul(ctm, Array.from(args[0]));
    } else if (fn === OPS.paintFormXObjectEnd) {
      ctm = stack.pop() || ctm;
    } else if (imageOps.has(fn)) {
      const b = bboxOf([apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 0, 1), apply(ctm, 1, 1)], viewport);
      if (b.w > 10 && b.h > 10) images.push(b);
    } else if (fn === OPS.constructPath) {
      const paint = args?.[0];
      const data = args?.[1]?.[0];
      if (!paintOps.has(paint) || !data || typeof data.length !== 'number') continue;
      for (const sub of subpaths(data)) {
        if (!sub.rectLike) continue;
        const b = bboxOf(sub.points.map(([x, y]) => apply(ctm, x, y)), viewport);
        if (b.w > 3 && b.h > 3) rects.push(b);
      }
    }
  }
  return { rects, images };
}

/**
 * Split DrawOPS path data into subpaths and flag box-like ones: axis-aligned
 * quadrilaterals, and rounded rectangles (axis-aligned sides joined by short
 * corner curves, the sides covering most of the perimeter).
 */
function subpaths(data) {
  const out = [];
  let cur = null;
  let curved = false;
  let straight = 0;      // total length of axis-aligned line segments
  let oblique = false;   // a straight segment that is not axis-aligned
  const flush = () => {
    if (cur && cur.length >= 2) {
      const pts = cur.slice();
      const first = pts[0], last = pts[pts.length - 1];
      if (pts.length > 4 && Math.abs(first[0] - last[0]) < 0.01 && Math.abs(first[1] - last[1]) < 0.01) pts.pop();
      // (a `re` with zero width/height arrives as moveTo + lineTo: a rule, not a box)
      let rectLike = !curved && pts.length === 4 && pts.every((p, k) => {
        const q = pts[(k + 1) % 4];
        return Math.abs(p[0] - q[0]) < 0.01 || Math.abs(p[1] - q[1]) < 0.01;
      });
      if (!rectLike && curved && !oblique) {
        const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
        const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
        rectLike = w > 0 && h > 0 && straight >= 0.7 * 2 * (w + h);
      }
      out.push({ points: pts, rectLike });
    }
    cur = null;
    curved = false;
    straight = 0;
    oblique = false;
  };
  let i = 0;
  while (i < data.length) {
    const op = data[i++];
    if (op === DRAW.moveTo) {
      flush();
      cur = [[data[i], data[i + 1]]];
      i += 2;
    } else if (op === DRAW.lineTo) {
      if (!cur) cur = [];
      const p = cur[cur.length - 1];
      if (p) {
        const dx = Math.abs(data[i] - p[0]), dy = Math.abs(data[i + 1] - p[1]);
        if (dx < 0.01 || dy < 0.01) straight += dx + dy;
        else oblique = true;
      }
      cur.push([data[i], data[i + 1]]);
      i += 2;
    } else if (op === DRAW.curveTo) {
      curved = true;
      if (cur) cur.push([data[i + 4], data[i + 5]]);
      i += 6;
    } else if (op === DRAW.quadraticCurveTo) {
      curved = true;
      if (cur) cur.push([data[i + 2], data[i + 3]]);
      i += 4;
    } else if (op === DRAW.closePath) {
      const p = cur?.[cur.length - 1], f = cur?.[0];
      if (p && f) {
        const dx = Math.abs(f[0] - p[0]), dy = Math.abs(f[1] - p[1]);
        if (dx < 0.01 || dy < 0.01) straight += dx + dy;
        else oblique = true;
      }
      flush();
    } else {
      break; // unknown encoding: stop rather than misread
    }
  }
  flush();
  return out;
}
