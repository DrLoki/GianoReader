/**
 * XY-Cut Layout Analysis Algorithm
 * Performs recursive XY-cut layout decomposition on a page's text items.
 */

export function performXYCut(items, pageBounds, options = {}) {
  const {
    thresholdX = 15, // horizontal gap threshold (vertical cuts)
    thresholdY = 10,  // vertical gap threshold (horizontal cuts)
    minWidth = 20,
    minHeight = 10,
    priority = 'Y',   // 'Y' (Rows first), 'X' (Columns first), or 'max-gap'
    borderedBoxes = []
  } = options;

  let nodeIdCounter = 0;

  // Initial block represents the whole page
  const rootBlock = {
    id: 'block-root',
    type: 'root',
    bounds: {
      x: pageBounds.x,
      y: pageBounds.y,
      w: pageBounds.w,
      h: pageBounds.h,
    },
    items: [...items],
    depth: 0,
    children: [],
  };

  // Helper to merge intervals and find gaps
  function findGaps(elements, axis, minVal, maxVal) {
    if (elements.length === 0) return [];

    // Extract intervals along the specified axis
    const intervals = elements.map(el => {
      if (axis === 'X') {
        return { start: el.x0, end: el.x1 };
      } else {
        return { start: el.y0, end: el.y1 };
      }
    });

    // Merge overlapping intervals
    intervals.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const interval of intervals) {
      if (merged.length === 0) {
        merged.push({ ...interval });
      } else {
        const last = merged[merged.length - 1];
        if (interval.start <= last.end) {
          last.end = Math.max(last.end, interval.end);
        } else {
          merged.push({ ...interval });
        }
      }
    }

    // Find gaps between merged intervals
    const gaps = [];

    // Check gap before the first interval
    if (merged.length > 0 && merged[0].start > minVal) {
      gaps.push({
        start: minVal,
        end: merged[0].start,
        size: merged[0].start - minVal
      });
    }

    // Check gaps between intervals
    for (let i = 0; i < merged.length - 1; i++) {
      const gapStart = merged[i].end;
      const gapEnd = merged[i + 1].start;
      if (gapEnd > gapStart) {
        gaps.push({
          start: gapStart,
          end: gapEnd,
          size: gapEnd - gapStart
        });
      }
    }

    // Check gap after the last interval
    if (merged.length > 0 && merged[merged.length - 1].end < maxVal) {
      gaps.push({
        start: merged[merged.length - 1].end,
        end: maxVal,
        size: maxVal - merged[merged.length - 1].end
      });
    }

    return gaps;
  }

  // Recursive partition function
  function subdivide(block) {
    const { items: blockItems, bounds, depth } = block;

    // Base conditions
    if (blockItems.length <= 1 || bounds.w < minWidth || bounds.h < minHeight) {
      finalizeLeafNode(block);
      return;
    }

    const minX = bounds.x;
    const maxX = bounds.x + bounds.w;
    const minY = bounds.y;
    const maxY = bounds.y + bounds.h;

    // Find gaps in both directions
    const xGaps = findGaps(blockItems, 'X', minX, maxX).filter(gap => gap.size >= thresholdX);
    const yGaps = findGaps(blockItems, 'Y', minY, maxY).filter(gap => gap.size >= thresholdY);

    // If no gaps exceed the thresholds, we have a leaf
    if (xGaps.length === 0 && yGaps.length === 0) {
      finalizeLeafNode(block);
      return;
    }

    let cutDirection = null;
    let selectedGaps = [];

    // Decide which direction to cut based on priority
    if (priority === 'X') {
      if (xGaps.length > 0) {
        cutDirection = 'X';
        selectedGaps = xGaps;
      } else if (yGaps.length > 0) {
        cutDirection = 'Y';
        selectedGaps = yGaps;
      }
    } else if (priority === 'Y') {
      if (yGaps.length > 0) {
        cutDirection = 'Y';
        selectedGaps = yGaps;
      } else if (xGaps.length > 0) {
        cutDirection = 'X';
        selectedGaps = xGaps;
      }
    } else {
      // 'max-gap' priority
      const maxXGap = xGaps.length > 0 ? Math.max(...xGaps.map(g => g.size)) : 0;
      const maxYGap = yGaps.length > 0 ? Math.max(...yGaps.map(g => g.size)) : 0;

      if (maxXGap >= maxYGap && maxXGap > 0) {
        cutDirection = 'X';
        selectedGaps = xGaps;
      } else if (maxYGap > 0) {
        cutDirection = 'Y';
        selectedGaps = yGaps;
      }
    }

    if (!cutDirection) {
      finalizeLeafNode(block);
      return;
    }

    block.type = 'container';
    block.cutDirection = cutDirection;

    // Generate child bounds based on cuts
    const children = [];
    if (cutDirection === 'X') {
      // Sort gaps from left to right
      selectedGaps.sort((a, b) => a.start - b.start);

      let currentX = minX;
      for (const gap of selectedGaps) {
        // Filter out cuts that fall too close to page margins to avoid empty margin splits
        const midGap = (gap.start + gap.end) / 2.0;
        const relPos = (midGap - minX) / bounds.w;
        if (relPos < 0.05 || relPos > 0.95) {
          // Left-margin gap: advance currentX so the next sub-block starts after
          // the margin. Right-margin gap: do NOT advance — trailing whitespace
          // must not swallow the last column's content.
          if (relPos < 0.05) {
            currentX = gap.end;
          }
          continue;
        }

        if (gap.start > currentX) {
          const subWidth = gap.start - currentX;

          // Skip trivial subdivisions that are too small
          if (subWidth < 1 || subWidth < minWidth) {
            currentX = gap.end;
            continue;
          }

          const subItems = blockItems.filter(item => item.x0 >= currentX && item.x1 <= gap.start);

          // If subdivision doesn't reduce element set, skip to avoid deep identical nesting
          if (subItems.length === 0 || subItems.length === blockItems.length) {
            currentX = gap.end;
            continue;
          }

          children.push({
            id: `block-${++nodeIdCounter}`,
            type: 'container',
            bounds: { x: currentX, y: minY, w: subWidth, h: bounds.h },
            items: subItems,
            depth: depth + 1,
            children: [],
          });
        }
        currentX = gap.end;
      }
      // Last sub-block after the last gap
      if (maxX > currentX) {
        const subWidth = maxX - currentX;
        if (subWidth >= 1 && subWidth >= minWidth) {
          const subItems = blockItems.filter(item => item.x0 >= currentX && item.x1 <= maxX);
          if (subItems.length > 0 && subItems.length !== blockItems.length) {
            children.push({
              id: `block-${++nodeIdCounter}`,
              type: 'container',
              bounds: { x: currentX, y: minY, w: subWidth, h: bounds.h },
              items: subItems,
              depth: depth + 1,
              children: [],
            });
          }
        }
      }
    } else {
      // CutDirection === 'Y'
      // Sort gaps from top to bottom
      selectedGaps.sort((a, b) => a.start - b.start);

      let currentY = minY;
      for (const gap of selectedGaps) {
        if (gap.start > currentY) {
          const subHeight = gap.start - currentY;

          // Skip trivial subdivisions that are too small
          if (subHeight < 1 || subHeight < minHeight) {
            currentY = gap.end;
            continue;
          }

          const subItems = blockItems.filter(item => item.y0 >= currentY && item.y1 <= gap.start);
          if (subItems.length === 0 || subItems.length === blockItems.length) {
            currentY = gap.end;
            continue;
          }

          children.push({
            id: `block-${++nodeIdCounter}`,
            type: 'container',
            bounds: { x: minX, y: currentY, w: bounds.w, h: subHeight },
            items: subItems,
            depth: depth + 1,
            children: [],
          });
        }
        currentY = gap.end;
      }
      // Last sub-block after the last gap
      if (maxY > currentY) {
        const subHeight = maxY - currentY;
        if (subHeight >= 1 && subHeight >= minHeight) {
          const subItems = blockItems.filter(item => item.y0 >= currentY && item.y1 <= maxY);
          if (subItems.length > 0 && subItems.length !== blockItems.length) {
            children.push({
              id: `block-${++nodeIdCounter}`,
              type: 'container',
              bounds: { x: minX, y: currentY, w: bounds.w, h: subHeight },
              items: subItems,
              depth: depth + 1,
              children: [],
            });
          }
        }
      }
    }

    // If no valid sub-blocks were created (e.g. elements fell inside the gaps due to minor boundary mismatches),
    // finalize as a leaf node.
    if (children.length === 0) {
      finalizeLeafNode(block);
      return;
    }

    // Recursively subdivide children
    block.children = children;
    for (const child of block.children) {
      subdivide(child);
    }
  }

  // Complete leaf node attributes (sorting items, calculating dominant styles)
  function finalizeLeafNode(block) {
    block.type = 'leaf';
    block.children = null;

    if (block.items.length === 0) {
      block.text = '';
      block.formatting = {
        fontFamily: 'default',
        fontSize: 10,
        fontWeight: 'normal',
        fontStyle: 'normal',
        color: '#ffffff',
        alignment: 'left',
      };
      return;
    }

    // Sort items to form a coherent text flow (top-to-bottom, then left-to-right)
    // We group items into rows where items are on roughly the same baseline (tolerance 4px)
    const sortedItems = [...block.items];
    sortedItems.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);

    const rows = [];
    for (const item of sortedItems) {
      let placed = false;
      for (const row of rows) {
        // If the item shares a similar vertical center with this row
        const rowAvgY = row.reduce((sum, el) => sum + (el.y0 + el.y1) / 2, 0) / row.length;
        const itemCenterY = (item.y0 + item.y1) / 2;
        if (Math.abs(itemCenterY - rowAvgY) < 5) {
          row.push(item);
          placed = true;
          break;
        }
      }
      if (!placed) {
        rows.push([item]);
      }
    }

    // Sort items inside each row by X coordinate
    rows.forEach(row => row.sort((a, b) => a.x0 - b.x0));
    // Sort rows by Y coordinate
    rows.sort((a, b) => {
      const avgYA = a.reduce((sum, el) => sum + el.y0, 0) / a.length;
      const avgYB = b.reduce((sum, el) => sum + el.y0, 0) / b.length;
      return avgYA - avgYB;
    });

    // Flatten back
    block.items = rows.flat();

    // Concatenate text
    const textSegments = [];
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const rowText = row.map(item => item.str).join(' ').replace(/\s+/g, ' ');
      textSegments.push(rowText);
    }
    block.text = textSegments.join('\n');

    // Extract dominant styles
    const fontSizes = {};
    const fontFamilies = {};
    let totalFontSize = 0;
    let color = '#ffffff'; // Default text color

    for (const item of block.items) {
      const size = Math.round(item.fontSize || 10);
      fontSizes[size] = (fontSizes[size] || 0) + 1;
      totalFontSize += item.fontSize || 10;

      const family = item.fontName || 'serif';
      fontFamilies[family] = (fontFamilies[family] || 0) + 1;
    }

    // Get dominant font size and average font size
    let dominantSize = 10;
    let maxCount = 0;
    for (const size in fontSizes) {
      if (fontSizes[size] > maxCount) {
        maxCount = fontSizes[size];
        dominantSize = parseInt(size, 10);
      }
    }
    const avgSize = Math.round((totalFontSize / block.items.length) * 10) / 10;

    // Get dominant font family
    let dominantFamily = 'default';
    maxCount = 0;
    for (const family in fontFamilies) {
      if (fontFamilies[family] > maxCount) {
        maxCount = fontFamilies[family];
        dominantFamily = family;
      }
    }

    // Infer styling flags
    const familyLower = dominantFamily.toLowerCase();
    const fontWeight = (familyLower.includes('bold') || familyLower.includes('goth') || familyLower.includes('black')) ? 'bold' : 'normal';
    const fontStyle = (familyLower.includes('italic') || familyLower.includes('oblique')) ? 'italic' : 'normal';

    // Calculate text alignment
    // We check the horizontal centers of lines relative to the block's boundaries
    let alignment = 'left';
    if (rows.length > 0) {
      let leftDiffSum = 0;
      let rightDiffSum = 0;
      let centerDiffSum = 0;

      const blockCenterX = block.bounds.x + block.bounds.w / 2;

      for (const row of rows) {
        if (row.length === 0) continue;
        const rowLeft = row[0].x0;
        const rowRight = row[row.length - 1].x1;
        const rowCenterX = (rowLeft + rowRight) / 2;

        const leftDiff = Math.abs(rowLeft - block.bounds.x);
        const rightDiff = Math.abs(block.bounds.x + block.bounds.w - rowRight);
        const centerDiff = Math.abs(rowCenterX - blockCenterX);

        leftDiffSum += leftDiff;
        rightDiffSum += rightDiff;
        centerDiffSum += centerDiff;
      }

      const avgLeftDiff = leftDiffSum / rows.length;
      const avgRightDiff = rightDiffSum / rows.length;
      const avgCenterDiff = centerDiffSum / rows.length;

      // If lines are centered, centerDiff will be very low
      if (avgCenterDiff < 6 && avgLeftDiff > 8 && avgRightDiff > 8) {
        alignment = 'center';
      } else if (avgRightDiff < 5 && avgLeftDiff > 8) {
        alignment = 'right';
      } else if (avgLeftDiff < 6 && avgRightDiff < 6 && rows.length > 1) {
        alignment = 'justify';
      } else {
        alignment = 'left';
      }
    }

    block.formatting = {
      fontFamily: dominantFamily,
      fontSize: dominantSize,
      avgFontSize: avgSize,
      fontWeight,
      fontStyle,
      color,
      alignment,
    };
  }

  // Begin recursive partitioning with bordered boxes first
  const rootChildren = [];
  let remainingItems = [...items];
  
  // Sort boxes from largest to smallest to handle nesting
  const sortedBoxes = [...borderedBoxes].sort((a, b) => (b.w * b.h) - (a.w * a.h));
  
  for (const box of sortedBoxes) {
    const insideItems = remainingItems.filter(item => {
      const cx = (item.x0 + item.x1) / 2;
      const cy = (item.y0 + item.y1) / 2;
      return cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h;
    });
    
    if (insideItems.length > 0) {
      // Remove these items from remainingItems
      remainingItems = remainingItems.filter(item => !insideItems.includes(item));
      
      const boxBlock = {
        id: `bordered-box-${++nodeIdCounter}`,
        type: 'container',
        isBorderedBox: true,
        bounds: {
          x: box.x,
          y: box.y,
          w: box.w,
          h: box.h
        },
        items: insideItems,
        depth: 1,
        children: []
      };
      
      // Run subdivide inside this box
      subdivide(boxBlock);
      rootChildren.push(boxBlock);
    }
  }
  
  // Now run standard subdivision on the remaining items at the root level!
  if (remainingItems.length > 0) {
    const tempRoot = {
      id: 'temp-root',
      type: 'root',
      bounds: rootBlock.bounds,
      items: remainingItems,
      depth: 0,
      children: []
    };
    subdivide(tempRoot);
    if (tempRoot.children && tempRoot.children.length > 0) {
      rootChildren.push(...tempRoot.children);
    } else if (tempRoot.type === 'leaf') {
      rootChildren.push(tempRoot);
    }
  }
  
  rootBlock.children = rootChildren;
  rootBlock.type = 'root';

  // Return the computed DOM tree and the projections for UI visualization
  return {
    root: rootBlock,
    projections: {
      xGaps: findGaps(items, 'X', pageBounds.x, pageBounds.x + pageBounds.w),
      yGaps: findGaps(items, 'Y', pageBounds.y, pageBounds.y + pageBounds.h),
      pageBounds
    }
  };
}

/**
 * Serializes the XY-Cut DOM Tree to clean XML, HTML or JSON formats
 */
export function serializeLayoutTree(node, format = 'json') {
  if (format === 'json') {
    // Return sanitized JSON tree without circular elements
    const cleanNode = (n) => {
      const copy = {
        id: n.id,
        type: n.type,
        bounds: n.bounds,
        depth: n.depth
      };
      if (n.cutDirection) copy.cutDirection = n.cutDirection;
      if (n.type === 'leaf') {
        copy.text = n.text;
        copy.formatting = n.formatting;
      }
      if (n.children) {
        copy.children = n.children.map(cleanNode);
      }
      return copy;
    };
    return JSON.stringify(cleanNode(node), null, 2);
  }

  if (format === 'xml') {
    const toXML = (n) => {
      const boundsStr = `x="${n.bounds.x.toFixed(1)}" y="${n.bounds.y.toFixed(1)}" w="${n.bounds.w.toFixed(1)}" h="${n.bounds.h.toFixed(1)}"`;
      if (n.type === 'leaf') {
        const textEscaped = n.text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
        
        const styleStr = `font-family="${n.formatting.fontFamily}" font-size="${n.formatting.fontSize}" font-weight="${n.formatting.fontWeight}" font-style="${n.formatting.fontStyle}" align="${n.formatting.alignment}"`;
        
        return `    <Block id="${n.id}" ${boundsStr} ${styleStr}>\n      <Text>${textEscaped}</Text>\n    </Block>`;
      }

      const dirStr = n.cutDirection ? ` cut="${n.cutDirection}"` : '';
      const childrenXML = n.children.map(c => toXML(c)).join('\n');
      
      const tag = n.type === 'root' ? 'DocumentLayout' : 'Container';
      return `<${tag} id="${n.id}" ${boundsStr}${dirStr}>\n${childrenXML}\n</${tag}>`;
    };
    return `<?xml version="1.0" encoding="UTF-8"?>\n${toXML(node)}`;
  }

  if (format === 'html') {
    const toHTML = (n) => {
      const inlineStyle = `position: absolute; left: ${n.bounds.x}px; top: ${n.bounds.y}px; width: ${n.bounds.w}px; height: ${n.bounds.h}px;`;
      if (n.type === 'leaf') {
        const leafStyle = `${inlineStyle} font-family: ${n.formatting.fontFamily}, sans-serif; font-size: ${n.formatting.fontSize}px; font-weight: ${n.formatting.fontWeight}; font-style: ${n.formatting.fontStyle}; text-align: ${n.formatting.alignment}; border: 1px solid rgba(255,255,255,0.15); box-sizing: border-box; overflow: hidden; padding: 4px; color: #fff; background: rgba(255,255,255,0.03);`;
        
        const textHTML = n.text.replace(/\n/g, '<br/>');
        return `  <div id="${n.id}" class="layout-leaf" style="${leafStyle}">${textHTML}</div>`;
      }

      const childrenHTML = n.children.map(c => toHTML(c)).join('\n');
      const containerStyle = `${inlineStyle} border: 1px dashed rgba(255,255,255,0.05);`;
      return `<div id="${n.id}" class="layout-container" style="${containerStyle}">\n${childrenHTML}\n</div>`;
    };

    const rootStyle = `position: relative; width: ${node.bounds.w}px; height: ${node.bounds.h}px; background: #1a1b26; overflow: auto;`;
    return `<!DOCTYPE html>\n<html>\n<head>\n  <meta charset="utf-8">\n  <title>Exported PDF Layout DOM</title>\n</head>\n<body style="margin:0; padding:20px; background:#12121e; display:flex; justify-content:center;">\n<div class="layout-root" style="${rootStyle}">\n${toHTML(node)}\n</div>\n</body>\n</html>`;
  }

  return '';
}
