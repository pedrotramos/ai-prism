import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { buildDeckTokenStyle } from './HtmlSlideFrame.jsx'
import { buildDeckAssetMap, resolveDeckAssets, DECK_ASSET_FALLBACK_CSS } from '../../lib/deckAssets.js'

// Editable variant of HtmlSlideFrame (manual HTML editing, Claude Design "Pro"
// parity). The sandboxed slide iframe becomes a full design surface: the DOM IS
// the model. An injected runtime handles, entirely inside the frame:
//   • single + MULTI selection (shift / ⌘ / ctrl-click toggles), with a ring
//     drawn over every selected node,
//   • a rich style snapshot (typography + full box model) reported to the parent,
//   • live inline-style / text / attribute patches applied to the selection,
//   • element CREATION (text, rectangle, oval, line, arrow, frame, image) by
//     dragging on the canvas — new nodes are absolutely positioned so they never
//     disturb the flowing layout,
//   • drag-to-move of absolutely-positioned elements,
//   • structural ops (delete / duplicate / group / ungroup / wrap-in-flex /
//     reorder) and a right-click CONTEXT MENU that surfaces them,
//   • whole-<section> replacement (setHtml) for undo/redo and AI tweaks,
// then re-serializes the CLEAN <section> back after every mutation. Everything
// the parent needs travels over postMessage (the frame is a unique sandbox
// origin). No marker attributes ever persist — overlays live outside <section>.
//
// HtmlSlideFrame stays the dumb, pointer-inert renderer (thumbnails + export);
// all editing risk is isolated here.

const STAGE_W = 1280
const STAGE_H = 720

// The in-iframe runtime. Pure vanilla JS; the whole editing engine lives here so
// the React side only orchestrates history/clipboard/AI. Talks to the parent
// exclusively through postMessage tagged `prism`.
const RUNTIME = `
<script>
(function () {
  var css = getComputedStyle(document.documentElement);
  var ACCENT = (css.getPropertyValue('--accent') || '#2D7FF9').trim();
  var root = document.querySelector('section');
  var selected = [];            // array of selected elements
  var editingEl = null;         // contenteditable text node being edited
  var tool = 'select';          // active tool: select | text | rect | oval | line | arrow | frame
  var layer = null;             // overlay layer (rings/hover), outside <section>
  var hoverBox = null;
  var marquee = null;           // create/drag preview box
  var guideX = null, guideY = null; // alignment guide lines (drawn while snapping)
  var drag = null;              // {mode:'create'|'move'|'resize'|'marquee', ...}
  var suppressClick = false;    // swallow the click synthesized right after a marquee drag
  var handles = [];             // 8 resize handles (single selection only)
  var HANDLE_DIRS = ['nw','n','ne','e','se','s','sw','w'];

  function px(v){ v = parseFloat(v); return isFinite(v) ? Math.round(v*10)/10 : 0; }
  function send(msg){ msg.prism = true; parent.postMessage(msg, '*'); }

  function ensureLayer(){
    if (layer) return;
    layer = document.createElement('div');
    layer.id = '__prism_layer';
    layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:2147483000;';
    document.body.appendChild(layer);
    hoverBox = document.createElement('div');
    hoverBox.style.cssText = 'position:absolute;pointer-events:none;border:1.5px dashed '+ACCENT+'99;border-radius:3px;display:none;';
    layer.appendChild(hoverBox);
    marquee = document.createElement('div');
    marquee.style.cssText = 'position:absolute;pointer-events:none;border:1.5px solid '+ACCENT+';background:'+ACCENT+'18;display:none;';
    layer.appendChild(marquee);
    // alignment guide lines (shown while dragging an absolute element that snaps)
    guideX = document.createElement('div');
    guideX.style.cssText = 'position:absolute;pointer-events:none;width:0;border-left:1px solid #ff2d78;display:none;z-index:2147483300;';
    layer.appendChild(guideX);
    guideY = document.createElement('div');
    guideY.style.cssText = 'position:absolute;pointer-events:none;height:0;border-top:1px solid #ff2d78;display:none;z-index:2147483300;';
    layer.appendChild(guideY);
    // 8 resize handles (corners + edges) — shown only for a single selection.
    var cursors = { nw:'nwse-resize', n:'ns-resize', ne:'nesw-resize', e:'ew-resize', se:'nwse-resize', s:'ns-resize', sw:'nesw-resize', w:'ew-resize' };
    HANDLE_DIRS.forEach(function(dir){
      var h = document.createElement('div');
      h.setAttribute('data-prism-handle', dir);
      h.style.cssText = 'position:absolute;width:10px;height:10px;box-sizing:border-box;'
        + 'background:#fff;border:1.5px solid '+ACCENT+';border-radius:2px;display:none;'
        + 'pointer-events:auto;z-index:2147483400;cursor:'+cursors[dir]+';';
      layer.appendChild(h); handles.push(h);
    });
  }
  // place the 8 handles around a single selected element's box; hide otherwise
  function drawHandles(){
    if (!handles.length) return;
    if (selected.length !== 1 || selected[0] === root){ handles.forEach(function(h){ h.style.display='none'; }); return; }
    var r = selected[0].getBoundingClientRect();
    var x = r.left + window.scrollX, y = r.top + window.scrollY;
    var pos = {
      nw:[x,y], n:[x+r.width/2,y], ne:[x+r.width,y],
      e:[x+r.width,y+r.height/2], se:[x+r.width,y+r.height],
      s:[x+r.width/2,y+r.height], sw:[x,y+r.height], w:[x,y+r.height/2],
    };
    handles.forEach(function(h){
      var p = pos[h.getAttribute('data-prism-handle')];
      h.style.display='block'; h.style.left=(p[0]-5)+'px'; h.style.top=(p[1]-5)+'px';
    });
  }
  // element-only child-index path from <section>, e.g. "1.0.2"
  function pathOf(el){
    var parts = [];
    while (el && el !== root){
      var p = el.parentNode; if (!p) break;
      var i = 0, n = p.firstElementChild;
      while (n && n !== el){ i++; n = n.nextElementSibling; }
      parts.unshift(i); el = p;
    }
    return parts.join('.');
  }
  function nodeAt(path){
    if (path === '' || path == null) return root;
    var el = root, parts = String(path).split('.');
    for (var k=0;k<parts.length;k++){ if (!el) return null; el = el.children[parseInt(parts[k],10)]; }
    return el || null;
  }
  function isTextLeaf(el){
    if (!el) return false;
    for (var i=0;i<el.childNodes.length;i++){ if (el.childNodes[i].nodeType === 1) return false; }
    return (el.textContent||'').trim().length > 0;
  }
  function sizingMode(el, prop){ // 'hug' | 'fixed' | 'fill'
    var v = el.style[prop];
    if (!v) return 'hug';
    if (/%/.test(v) || v === 'auto' && el.style.flex) return 'fill';
    if (/px|em|rem|vh|vw/.test(v)) return 'fixed';
    if (parseFloat(el.style.flexGrow) >= 1) return 'fill';
    return 'hug';
  }
  function snapshot(el){
    var cs = getComputedStyle(el), st = el.style;
    return {
      tag: el.tagName.toLowerCase(),
      textLeaf: isTextLeaf(el),
      text: isTextLeaf(el) ? el.textContent : '',
      isImage: el.tagName === 'IMG',
      src: el.tagName === 'IMG' ? (el.getAttribute('src')||'') : '',
      objectFit: cs.objectFit,
      childCount: el.children.length,
      computed: {
        fontSize: px(cs.fontSize), color: cs.color, fontWeight: cs.fontWeight, fontStyle: cs.fontStyle,
        textAlign: cs.textAlign, letterSpacing: cs.letterSpacing==='normal'?0:px(cs.letterSpacing),
        lineHeight: cs.lineHeight==='normal'?'':(Math.round((parseFloat(cs.lineHeight)/parseFloat(cs.fontSize))*100)/100||''),
        textTransform: cs.textTransform, textDecorationLine: cs.textDecorationLine,
        fontFamily: cs.fontFamily,
        backgroundColor: cs.backgroundColor, opacity: cs.opacity, borderRadius: px(cs.borderTopLeftRadius),
        overflow: cs.overflow, boxShadow: cs.boxShadow,
        borderWidth: px(cs.borderTopWidth), borderStyle: cs.borderTopStyle, borderColor: cs.borderTopColor,
        width: px(cs.width), height: px(cs.height),
        position: cs.position, top: st.top||'', left: st.left||'', right: st.right||'', bottom: st.bottom||'', zIndex: st.zIndex||'',
        flexGrow: st.flexGrow||'', alignSelf: cs.alignSelf,
        display: cs.display,
        paddingTop: px(cs.paddingTop), paddingRight: px(cs.paddingRight), paddingBottom: px(cs.paddingBottom), paddingLeft: px(cs.paddingLeft),
        marginTop: px(cs.marginTop), marginRight: px(cs.marginRight), marginBottom: px(cs.marginBottom), marginLeft: px(cs.marginLeft),
      },
      sizing: { width: sizingMode(el,'width'), height: sizingMode(el,'height') },
      inline: {
        fontSize:!!st.fontSize, color:!!st.color, fontWeight:!!st.fontWeight, fontStyle:!!st.fontStyle,
        textAlign:!!st.textAlign, letterSpacing:!!st.letterSpacing, lineHeight:!!st.lineHeight,
        textTransform:!!st.textTransform, textDecoration:!!st.textDecorationLine,
        background:!!(st.background||st.backgroundColor), opacity:!!st.opacity, borderRadius:!!st.borderRadius,
        overflow:!!st.overflow, boxShadow:!!st.boxShadow, border:!!(st.border||st.borderWidth||st.borderTopWidth),
        width:!!st.width, height:!!st.height, position:!!st.position, zIndex:!!st.zIndex,
        padding:!!(st.padding||st.paddingTop||st.paddingLeft), margin:!!(st.margin||st.marginTop||st.marginLeft),
      },
    };
  }
  function position(box, el){
    if (!el || el === root){ box.style.display='none'; return; }
    var r = el.getBoundingClientRect();
    box.style.display='block';
    box.style.left=(r.left+window.scrollX)+'px'; box.style.top=(r.top+window.scrollY)+'px';
    box.style.width=r.width+'px'; box.style.height=r.height+'px';
  }
  var rings = [];
  function drawRings(){
    ensureLayer();
    // reuse/create ring elements
    while (rings.length < selected.length){
      var d = document.createElement('div');
      d.className='__prism_ring';
      d.style.cssText='position:absolute;pointer-events:none;border:2px solid '+ACCENT+';border-radius:3px;box-shadow:0 0 0 1px rgba(255,255,255,.5);';
      layer.appendChild(d); rings.push(d);
    }
    while (rings.length > selected.length){ layer.removeChild(rings.pop()); }
    for (var i=0;i<selected.length;i++) position(rings[i], selected[i]);
    drawHandles();
  }
  function reselect(){ drawRings(); }
  function serialize(){
    var clone = root.cloneNode(true);
    clone.querySelectorAll('[contenteditable]').forEach(function(n){ n.removeAttribute('contenteditable'); });
    // DS asset <img>s render with a resolved data-URI src for WYSIWYG, but the
    // STORED html must keep only the symbolic id (data-ds-asset-id/data-ds-logo)
    // so it stays small and re-themeable — strip the baked src on the way out.
    clone.querySelectorAll('img[data-ds-asset-id],img[data-ds-logo]').forEach(function(n){
      n.removeAttribute('src'); n.removeAttribute('data-ds-missing');
    });
    send({ kind:'html', html: clone.outerHTML });
  }
  function emitSelect(){
    if (!selected.length){ send({ kind:'deselect' }); return; }
    if (selected.length === 1){ send({ kind:'select', paths:[pathOf(selected[0])], info: snapshot(selected[0]) }); }
    else { send({ kind:'select', paths: selected.map(pathOf), info: { multi:true, count: selected.length } }); }
  }
  function setSelection(els, opts){
    opts = opts || {};
    if (editingEl && els.indexOf(editingEl) === -1) stopEditing();
    selected = els.filter(function(e){ return e && e !== root; });
    drawRings();
    if (!opts.silent) emitSelect();
  }
  function toggle(el){
    var i = selected.indexOf(el);
    if (i === -1) selected.push(el); else selected.splice(i,1);
    setSelection(selected.slice());
  }
  function stopEditing(){
    if (!editingEl) return;
    editingEl.removeAttribute('contenteditable');
    editingEl = null; serialize();
  }
  function startEditing(el){
    if (!isTextLeaf(el)) return;
    editingEl = el; el.setAttribute('contenteditable','true'); el.focus();
    var r = document.createRange(); r.selectNodeContents(el);
    var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  }

  // ---- element creation ------------------------------------------------------
  function makeEl(type, box){
    var e;
    if (type === 'text'){
      e = document.createElement('div'); e.textContent = 'Texto';
      e.style.cssText = 'font-family:var(--font-body,sans-serif);font-size:24px;color:var(--primary,#111);line-height:1.3;';
    } else if (type === 'rect' || type === 'frame'){
      e = document.createElement('div');
      e.style.cssText = 'background:'+(type==='frame'?'transparent':'var(--accent,#2D7FF9)')+';border-radius:'+(type==='frame'?'0':'8px')+';'+(type==='frame'?'border:2px solid var(--accent,#2D7FF9);':'');
    } else if (type === 'oval'){
      e = document.createElement('div'); e.style.cssText = 'background:var(--accent,#2D7FF9);border-radius:9999px;';
    } else if (type === 'line' || type === 'arrow'){
      e = document.createElement('div');
      e.style.cssText = 'height:0;border-top:3px solid var(--primary,#111);'+(type==='arrow'?'position:relative;':'');
      if (type==='arrow'){ /* arrowhead via box-shadow-ish: use a simple triangle span */
        var head=document.createElement('span');
        head.style.cssText='position:absolute;right:-1px;top:-6px;width:0;height:0;border-left:12px solid var(--primary,#111);border-top:6px solid transparent;border-bottom:6px solid transparent;';
        e.appendChild(head);
      }
    } else { e = document.createElement('div'); }
    e.style.position = 'absolute';
    e.style.left = Math.round(box.x)+'px'; e.style.top = Math.round(box.y)+'px';
    if (type === 'line' || type === 'arrow'){ e.style.width = Math.max(20,Math.round(box.w))+'px'; }
    else if (type !== 'text'){ e.style.width = Math.max(8,Math.round(box.w))+'px'; e.style.height = Math.max(8,Math.round(box.h))+'px'; }
    return e;
  }
  function createImage(dataUrl, box){
    var e = document.createElement('img'); e.setAttribute('src', dataUrl);
    e.style.cssText='position:absolute;object-fit:contain;';
    e.style.left=Math.round(box.x)+'px'; e.style.top=Math.round(box.y)+'px';
    e.style.width=Math.max(40,Math.round(box.w||220))+'px'; e.style.height=Math.max(40,Math.round(box.h||160))+'px';
    root.appendChild(e); setSelection([e]); serialize();
  }

  // ---- structural ops --------------------------------------------------------
  // Direct children of the slide root whose on-screen box intersects the marquee
  // rect (page coords). Marquee selects only TOP-LEVEL elements — the same grain
  // the tree/canvas click selects — so a drag-select doesn't grab every nested
  // span at once. A tiny threshold ignores zero-area nodes.
  function marqueeHits(mx, my, mw, mh){
    var out = [];
    for (var i=0;i<root.children.length;i++){
      var el = root.children[i];
      var r = el.getBoundingClientRect();
      var ex = r.left + window.scrollX, ey = r.top + window.scrollY;
      if (r.width < 2 || r.height < 2) continue;
      if (ex < mx+mw && ex+r.width > mx && ey < my+mh && ey+r.height > my) out.push(el);
    }
    return out;
  }
  function opDelete(){ selected.forEach(function(e){ if (e.parentNode) e.parentNode.removeChild(e); }); setSelection([]); serialize(); }
  function opDuplicate(){
    var clones = selected.map(function(e){
      var c = e.cloneNode(true);
      // nudge absolute clones so they're visible
      if (c.style && c.style.position==='absolute'){ c.style.left=(parseFloat(c.style.left||0)+16)+'px'; c.style.top=(parseFloat(c.style.top||0)+16)+'px'; }
      e.parentNode.insertBefore(c, e.nextSibling); return c;
    });
    setSelection(clones); serialize();
  }
  function opGroup(){
    if (selected.length < 2) return;
    // group only siblings; use the first's parent, insert wrapper before the first
    var parent = selected[0].parentNode;
    var g = document.createElement('div'); g.style.cssText='display:flex;gap:16px;align-items:flex-start;';
    parent.insertBefore(g, selected[0]);
    selected.forEach(function(e){ g.appendChild(e); });
    setSelection([g]); serialize();
  }
  function opUngroup(){
    var next=[];
    selected.forEach(function(g){
      if (g.children.length){ var kids=[].slice.call(g.children); kids.forEach(function(k){ g.parentNode.insertBefore(k,g); next.push(k); }); g.parentNode.removeChild(g); }
    });
    setSelection(next); serialize();
  }
  function opWrapFlex(){
    if (!selected.length) return;
    var parent = selected[0].parentNode;
    var w = document.createElement('div'); w.style.cssText='display:flex;gap:16px;align-items:center;';
    parent.insertBefore(w, selected[0]);
    selected.forEach(function(e){ w.appendChild(e); });
    setSelection([w]); serialize();
  }
  function opReorder(dir){ // 'front' | 'back' | 'forward' | 'backward'
    selected.forEach(function(e){
      var p=e.parentNode; if(!p) return;
      if (dir==='front') p.appendChild(e);
      else if (dir==='back') p.insertBefore(e, p.firstElementChild);
      else if (dir==='forward' && e.nextElementSibling) p.insertBefore(e.nextElementSibling, e);
      else if (dir==='backward' && e.previousElementSibling) p.insertBefore(e, e.previousElementSibling);
    });
    reselect(); serialize();
  }
  // Move a node in the tree (drag-and-drop reorder / reparent, item 1). Both
  // endpoints are resolved BEFORE mutating — a child-index path shifts the moment
  // the source detaches, so resolving by reference first keeps the drop correct.
  // position: 'before' | 'after' (sibling of ref) | 'inside' (last child of ref).
  // Guards: never move the root, never drop a node into itself or its own subtree
  // (that would detach the branch), and 'inside' the root means append at top level.
  function opMove(fromPath, toPath, position){
    var src = nodeAt(fromPath), ref = nodeAt(toPath);
    if (!src || !ref || src === root || src === ref) return;
    if (src.contains(ref)) return; // ref is inside src → illegal reparent
    if (position === 'inside'){
      ref.appendChild(src);
    } else if (ref === root){
      root.appendChild(src); // no siblings of the slide itself — nest at top level
    } else if (position === 'before'){
      ref.parentNode.insertBefore(src, ref);
    } else {
      ref.parentNode.insertBefore(src, ref.nextSibling);
    }
    setSelection([src]); serialize();
  }

  // ---- alignment guides + snap ----------------------------------------------
  // These mirror the pure geometry in client/src/lib/deckAlign.js (computeSnap /
  // alignBoxes / distributeBoxes), which the QA harness tests directly — keep the
  // two in sync. All boxes here are ROOT-LOCAL px (top/left off the slide box),
  // the same space absolute elements are positioned in.
  var SNAP = 6; // px threshold
  function rootLocalBox(el){
    var rr = root.getBoundingClientRect(), r = el.getBoundingClientRect();
    return { left: r.left - rr.left, top: r.top - rr.top, width: r.width, height: r.height };
  }
  // guide candidates: edges + centers of every sibling (except the ones moving)
  // plus the slide's own edges and center lines.
  function snapLines(exclude){
    var xs = [0, root.clientWidth/2, root.clientWidth];
    var ys = [0, root.clientHeight/2, root.clientHeight];
    for (var i=0;i<root.children.length;i++){
      var el = root.children[i];
      if (exclude.indexOf(el) !== -1) continue;
      var b = rootLocalBox(el);
      xs.push(b.left, b.left + b.width/2, b.left + b.width);
      ys.push(b.top, b.top + b.height/2, b.top + b.height);
    }
    return { xs: xs, ys: ys };
  }
  function bestSnap(anchors, lines){
    var best = null;
    for (var i=0;i<anchors.length;i++){
      for (var j=0;j<lines.length;j++){
        var d = lines[j] - anchors[i];
        if (Math.abs(d) <= SNAP && (best === null || Math.abs(d) < Math.abs(best.delta))) best = { delta:d, guide:lines[j] };
      }
    }
    return best;
  }
  // snap the moving element's box to nearby guides; returns {dx,dy} correction and
  // draws the guide lines that engaged (root-local coords → page coords for the
  // overlay). Pass the box in root-local space.
  function applySnap(box, lines){
    var ax = bestSnap([box.left, box.left+box.width/2, box.left+box.width], lines.xs);
    var ay = bestSnap([box.top, box.top+box.height/2, box.top+box.height], lines.ys);
    var rr = root.getBoundingClientRect();
    if (ax){ guideX.style.display='block'; guideX.style.left=(rr.left+window.scrollX+ax.guide)+'px'; guideX.style.top=(rr.top+window.scrollY)+'px'; guideX.style.height=root.clientHeight+'px'; }
    else { guideX.style.display='none'; }
    if (ay){ guideY.style.display='block'; guideY.style.top=(rr.top+window.scrollY+ay.guide)+'px'; guideY.style.left=(rr.left+window.scrollX)+'px'; guideY.style.width=root.clientWidth+'px'; }
    else { guideY.style.display='none'; }
    return { dx: ax ? ax.delta : 0, dy: ay ? ay.delta : 0 };
  }
  function hideGuides(){ if (guideX) guideX.style.display='none'; if (guideY) guideY.style.display='none'; }

  // ---- align / distribute (multi-selection, absolute elements) ---------------
  // Mirrors alignBoxes/distributeBoxes in deckAlign.js. Operates on the absolute
  // elements in the current selection — flowing elements are skipped (moving them
  // by px fights the layout). Writes left/top and re-serializes.
  function absSelected(){ return selected.filter(function(e){ return e && e !== root && getComputedStyle(e).position === 'absolute'; }); }
  function opAlign(mode){
    var els = absSelected(); if (els.length < 2) return;
    var boxes = els.map(rootLocalBox);
    var minL=Infinity,minT=Infinity,maxR=-Infinity,maxB=-Infinity;
    boxes.forEach(function(b){ minL=Math.min(minL,b.left); minT=Math.min(minT,b.top); maxR=Math.max(maxR,b.left+b.width); maxB=Math.max(maxB,b.top+b.height); });
    var cx=(minL+maxR)/2, cy=(minT+maxB)/2;
    els.forEach(function(el,i){
      var b = boxes[i], left = b.left, top = b.top;
      if (mode==='left') left=minL; else if (mode==='right') left=maxR-b.width; else if (mode==='hcenter') left=cx-b.width/2;
      else if (mode==='top') top=minT; else if (mode==='bottom') top=maxB-b.height; else if (mode==='vmiddle') top=cy-b.height/2;
      el.style.left=Math.round(left)+'px'; el.style.top=Math.round(top)+'px';
    });
    reselect(); serialize(); emitSelect();
  }
  function opDistribute(axis){
    var els = absSelected(); if (els.length < 3) return;
    var horiz = axis==='h';
    var boxes = els.map(rootLocalBox);
    var order = els.map(function(_,i){return i;}).sort(function(a,b){ return (horiz?boxes[a].left:boxes[a].top) - (horiz?boxes[b].left:boxes[b].top); });
    var st = function(i){ return horiz?boxes[i].left:boxes[i].top; };
    var sz = function(i){ return horiz?boxes[i].width:boxes[i].height; };
    var f = order[0], l = order[order.length-1];
    var span = (st(l)+sz(l)) - st(f);
    var total = order.reduce(function(s,i){ return s+sz(i); }, 0);
    var gap = (span-total)/(order.length-1);
    var cursor = st(f);
    order.forEach(function(i){
      if (horiz) els[i].style.left=Math.round(cursor)+'px'; else els[i].style.top=Math.round(cursor)+'px';
      cursor += sz(i)+gap;
    });
    reselect(); serialize(); emitSelect();
  }

  // ---- pointer interactions --------------------------------------------------
  function stagePoint(ev){ return { x: ev.clientX + window.scrollX, y: ev.clientY + window.scrollY }; }
  document.addEventListener('mousedown', function(ev){
    // any pointer-down inside the frame dismisses a parent context menu
    // (the parent's own outside-click listener can't see clicks in this
    // cross-origin iframe, so we forward the signal explicitly)
    send({ kind:'dismissMenu' });
    if (editingEl) return;
    // resize handle grabbed? (single selection) — start a resize drag
    var hdir = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-prism-handle');
    if (hdir && selected.length === 1){
      ev.preventDefault(); ev.stopPropagation();
      var el = selected[0], r = el.getBoundingClientRect();
      var cs = getComputedStyle(el), p0 = stagePoint(ev);
      drag = { mode:'resize', el: el, dir: hdir, x0: p0.x, y0: p0.y,
        w0: r.width, h0: r.height,
        abs: cs.position === 'absolute',
        left0: parseFloat(el.style.left)||0, top0: parseFloat(el.style.top)||0 };
      return;
    }
    if (tool !== 'select'){
      ev.preventDefault(); ev.stopPropagation();
      var p = stagePoint(ev);
      drag = { mode:'create', type: tool, x0:p.x, y0:p.y };
      ensureLayer(); marquee.style.display='block';
      marquee.style.left=p.x+'px'; marquee.style.top=p.y+'px'; marquee.style.width='0px'; marquee.style.height='0px';
      return;
    }
    // move an already-selected absolute element by dragging it
    var el = ev.target;
    if (el !== document.body && el !== root && selected.indexOf(el) !== -1 && getComputedStyle(el).position === 'absolute'){
      var p2 = stagePoint(ev);
      // precompute snap guides once (siblings don't move during the drag). Hold
      // Alt to bypass snapping for fine placement.
      drag = { mode:'move', el: el, x0:p2.x, y0:p2.y, left0: parseFloat(el.style.left)||0, top0: parseFloat(el.style.top)||0,
        lines: ev.altKey ? null : snapLines([el]), box0: rootLocalBox(el) };
      ev.preventDefault();
      return;
    }
    // press-drag on empty area (the slide root/body) → marquee select. A plain
    // click without drag still clears the selection via the click handler.
    if (el === root || el === document.body || el === document.documentElement){
      // preventDefault stops the browser from starting a NATIVE text selection
      // as the drag sweeps over headings/paragraphs (the blue highlight bug).
      ev.preventDefault();
      var pm = stagePoint(ev);
      drag = { mode:'marquee', x0: pm.x, y0: pm.y, additive: ev.shiftKey || ev.metaKey || ev.ctrlKey, base: selected.slice() };
      ensureLayer(); marquee.style.display='block';
      marquee.style.left=pm.x+'px'; marquee.style.top=pm.y+'px'; marquee.style.width='0px'; marquee.style.height='0px';
    }
  }, true);
  document.addEventListener('mousemove', function(ev){
    if (!drag) return;
    var p = stagePoint(ev);
    if (drag.mode === 'create' || drag.mode === 'marquee'){
      ev.preventDefault();
      // clear any native text selection the drag may have begun before the
      // mousedown preventDefault caught it, so no blue highlight lingers
      if (drag.mode === 'marquee'){ var s = window.getSelection && window.getSelection(); if (s && s.removeAllRanges) s.removeAllRanges(); }
      var x=Math.min(p.x,drag.x0), y=Math.min(p.y,drag.y0), w=Math.abs(p.x-drag.x0), h=Math.abs(p.y-drag.y0);
      marquee.style.left=x+'px'; marquee.style.top=y+'px'; marquee.style.width=w+'px'; marquee.style.height=h+'px';
    } else if (drag.mode === 'move'){
      var nl = drag.left0 + (p.x-drag.x0), nt = drag.top0 + (p.y-drag.y0);
      if (drag.lines){
        // snap the moving box (root-local) to nearby sibling/slide guides
        var mb = { left: nl, top: nt, width: drag.box0.width, height: drag.box0.height };
        var snap = applySnap(mb, drag.lines);
        nl += snap.dx; nt += snap.dy;
      }
      drag.el.style.left=Math.round(nl)+'px';
      drag.el.style.top=Math.round(nt)+'px';
      reselect();
    } else if (drag.mode === 'resize'){
      var dx = p.x - drag.x0, dy = p.y - drag.y0, dir = drag.dir;
      var w = drag.w0, h = drag.h0, left = drag.left0, top = drag.top0;
      if (dir.indexOf('e') !== -1) w = Math.max(8, drag.w0 + dx);
      if (dir.indexOf('s') !== -1) h = Math.max(8, drag.h0 + dy);
      if (dir.indexOf('w') !== -1){ w = Math.max(8, drag.w0 - dx); if (drag.abs) left = drag.left0 + (drag.w0 - w); }
      if (dir.indexOf('n') !== -1){ h = Math.max(8, drag.h0 - dy); if (drag.abs) top = drag.top0 + (drag.h0 - h); }
      // width/height only along the axes the handle controls
      if (dir === 'n' || dir === 's'){ drag.el.style.height = Math.round(h)+'px'; }
      else if (dir === 'e' || dir === 'w'){ drag.el.style.width = Math.round(w)+'px'; }
      else { drag.el.style.width = Math.round(w)+'px'; drag.el.style.height = Math.round(h)+'px'; }
      if (drag.abs){ drag.el.style.left = Math.round(left)+'px'; drag.el.style.top = Math.round(top)+'px'; }
      reselect();
    }
  }, true);
  document.addEventListener('mouseup', function(ev){
    if (!drag) return;
    var p = stagePoint(ev);
    if (drag.mode === 'create'){
      marquee.style.display='none';
      var x=Math.min(p.x,drag.x0), y=Math.min(p.y,drag.y0), w=Math.abs(p.x-drag.x0), h=Math.abs(p.y-drag.y0);
      var rr = root.getBoundingClientRect();
      var box = { x:x-(rr.left+window.scrollX), y:y-(rr.top+window.scrollY), w:w, h:h };
      if (w < 6 && h < 6){ box.w = drag.type==='text'?200:120; box.h = drag.type==='text'?40:120; } // click w/o drag → default
      var el = makeEl(drag.type, box);
      root.appendChild(el);
      setSelection([el]);
      if (drag.type === 'text') startEditing(el);
      serialize();
      send({ kind:'toolDone' }); tool = 'select';
    } else if (drag.mode === 'marquee'){
      marquee.style.display='none';
      var mx=Math.min(p.x,drag.x0), my=Math.min(p.y,drag.y0), mw=Math.abs(p.x-drag.x0), mh=Math.abs(p.y-drag.y0);
      if (mw < 5 && mh < 5){ drag = null; return; } // treat as a click (clear handled elsewhere)
      var hits = marqueeHits(mx, my, mw, mh);
      // additive marquee (shift/meta) unions with the prior selection
      var next = drag.additive ? drag.base.slice() : [];
      hits.forEach(function(el){ if (next.indexOf(el) === -1) next.push(el); });
      setSelection(next);
      // the browser fires a click on the empty area right after this mouseup,
      // and the click handler would clear the selection we just made — swallow it
      suppressClick = true;
    }
    else if (drag.mode === 'move'){ hideGuides(); serialize(); emitSelect(); }
    else if (drag.mode === 'resize'){ serialize(); emitSelect(); }
    drag = null;
  }, true);

  document.addEventListener('click', function(ev){
    if (tool !== 'select') return;
    // swallow the click the browser synthesizes right after a marquee drag, so
    // it doesn't clear the just-made selection
    if (suppressClick){ suppressClick = false; ev.preventDefault(); ev.stopPropagation(); return; }
    var el = ev.target;
    if (el && el.getAttribute && el.getAttribute('data-prism-handle')) return; // resize handle
    if (el === editingEl) return;
    if (el === document.body || el === document.documentElement){ setSelection([]); return; }
    ev.preventDefault(); ev.stopPropagation();
    var additive = ev.shiftKey || ev.metaKey || ev.ctrlKey;
    if (additive) toggle(el);
    else setSelection([el]);
  }, true);
  document.addEventListener('dblclick', function(ev){
    var el = ev.target;
    if (!isTextLeaf(el)) return;
    ev.preventDefault(); ev.stopPropagation();
    setSelection([el], { silent:true }); startEditing(el);
  }, true);
  document.addEventListener('contextmenu', function(ev){
    var el = ev.target;
    if (el === document.body || el === document.documentElement) return;
    ev.preventDefault();
    if (selected.indexOf(el) === -1) setSelection([el]);
    send({ kind:'contextmenu', x: ev.clientX, y: ev.clientY, paths: selected.map(pathOf) });
  }, true);
  document.addEventListener('mouseover', function(ev){
    if (tool !== 'select' || drag) return;
    var el = ev.target;
    if (!el || el===document.body || el===root || selected.indexOf(el)!==-1 || el===editingEl){ if(hoverBox) hoverBox.style.display='none'; return; }
    ensureLayer(); position(hoverBox, el);
  }, true);
  document.addEventListener('mouseout', function(){ if(hoverBox) hoverBox.style.display='none'; }, true);
  // Arrow-key nudge: move selected ABSOLUTE elements by 1px (10px with Shift).
  // Only absolute elements move — nudging a flowing element by pixels would
  // fight the layout — so a selection with none is a no-op (arrows pass through).
  // Skipped while editing text so caret navigation still works.
  document.addEventListener('keydown', function(ev){
    if (editingEl) return;
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight' && ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
    var movable = selected.filter(function(e){ return e && e !== root && getComputedStyle(e).position === 'absolute'; });
    if (!movable.length) return;
    ev.preventDefault();
    var step = ev.shiftKey ? 10 : 1;
    var dx = ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0;
    var dy = ev.key === 'ArrowUp' ? -step : ev.key === 'ArrowDown' ? step : 0;
    movable.forEach(function(e){
      e.style.left = Math.round((parseFloat(e.style.left)||0) + dx)+'px';
      e.style.top = Math.round((parseFloat(e.style.top)||0) + dy)+'px';
    });
    reselect(); serialize(); emitSelect();
  }, true);
  document.addEventListener('blur', function(ev){ if (ev.target === editingEl) stopEditing(); }, true);
  document.addEventListener('input', function(ev){ if (ev.target === editingEl) reselect(); }, true);
  window.addEventListener('resize', reselect);
  window.addEventListener('scroll', reselect, true);

  window.addEventListener('message', function(e){
    var m = e.data || {}; if (!m.prism) return;
    if (m.kind === 'select'){ var els=(m.paths||[]).map(nodeAt).filter(Boolean); setSelection(els); }
    else if (m.kind === 'clear'){ setSelection([]); }
    else if (m.kind === 'tool'){ tool = m.tool || 'select'; if (tool!=='select') setSelection([]); }
    else if (m.kind === 'applyStyle'){
      var targets = (m.paths||selected.map(pathOf)).map(nodeAt).filter(Boolean);
      targets.forEach(function(el){
        for (var k in m.style){
          var prop = k.replace(/[A-Z]/g,function(c){return '-'+c.toLowerCase();});
          if (m.style[k] === null || m.style[k] === '') el.style.removeProperty(prop);
          else el.style.setProperty(prop, m.style[k]);
        }
      });
      reselect(); serialize(); emitSelect();
    }
    else if (m.kind === 'setText'){ var t=nodeAt(m.path); if(t){ t.textContent=m.text; reselect(); serialize(); } }
    else if (m.kind === 'setAttr'){ var a=nodeAt(m.path); if(a){ if(m.value==null) a.removeAttribute(m.attr); else a.setAttribute(m.attr,m.value);
      // Replacing an <img>'s src turns a DS asset into a user-customized image:
      // drop the symbolic marker so serialize() keeps the new src (instead of
      // stripping it) and export stops re-resolving the template's original.
      if(m.attr==='src' && m.value!=null && a.tagName==='IMG'){ a.removeAttribute('data-ds-asset-id'); a.removeAttribute('data-ds-logo'); a.removeAttribute('data-ds-missing'); }
      reselect(); serialize(); emitSelect(); } }
    else if (m.kind === 'setHtml'){
      // replace the whole <section> content (undo/redo, AI tweak). Rebuild from
      // the provided outerHTML; keep selection cleared (paths may have shifted).
      var tmp = document.createElement('div'); tmp.innerHTML = m.html;
      var next = tmp.querySelector('section');
      if (next){ root.replaceWith(next); root = next; }
      selected = []; if (layer){ rings.forEach(function(r){layer.removeChild(r);}); rings=[]; }
      drawRings();
      if (!m.silent){ send({ kind:'html', html: root.outerHTML }); send({ kind:'deselect' }); }
    }
    else if (m.kind === 'createImage'){ var rr=root.getBoundingClientRect(); createImage(m.dataUrl, { x:(rr.width-220)/2, y:(rr.height-160)/2, w:m.w, h:m.h }); }
    else if (m.kind === 'paste'){
      var made = [];
      (m.clips||[]).forEach(function(htmlStr){
        var tmp = document.createElement('div'); tmp.innerHTML = htmlStr;
        var node = tmp.firstElementChild; if (!node) return;
        // nudge an absolute paste so it's visibly offset from the original
        if (node.style && node.style.position === 'absolute'){ node.style.left=(parseFloat(node.style.left||0)+20)+'px'; node.style.top=(parseFloat(node.style.top||0)+20)+'px'; }
        root.appendChild(node); made.push(node);
      });
      if (made.length){ setSelection(made); serialize(); }
    }
    else if (m.kind === 'op'){
      if (m.paths){ var e2=m.paths.map(nodeAt).filter(Boolean); if(e2.length) selected=e2; }
      if (m.op==='delete') opDelete();
      else if (m.op==='duplicate') opDuplicate();
      else if (m.op==='group') opGroup();
      else if (m.op==='ungroup') opUngroup();
      else if (m.op==='wrapFlex') opWrapFlex();
      else if (m.op==='front'||m.op==='back'||m.op==='forward'||m.op==='backward') opReorder(m.op);
      else if (m.op==='alignLeft') opAlign('left');
      else if (m.op==='alignHCenter') opAlign('hcenter');
      else if (m.op==='alignRight') opAlign('right');
      else if (m.op==='alignTop') opAlign('top');
      else if (m.op==='alignVMiddle') opAlign('vmiddle');
      else if (m.op==='alignBottom') opAlign('bottom');
      else if (m.op==='distributeH') opDistribute('h');
      else if (m.op==='distributeV') opDistribute('v');
    }
    else if (m.kind === 'move'){ opMove(m.from, m.to, m.position); }
    else if (m.kind === 'reselect'){ reselect(); }
  });
  send({ kind:'ready' });
})();
<\/script>`

function buildEditableSrcDoc(sectionHtml, tokenStyle) {
  return `<!doctype html><html><head><meta charset="utf-8">
<style data-ds-tokens>${tokenStyle}</style>
<style>
  html,body{margin:0;padding:0;width:${STAGE_W}px;height:${STAGE_H}px;overflow:hidden;
    background:var(--background,#fff);font-family:var(--font-body,var(--font-sans,system-ui));cursor:default;}
  section.slide,section{box-sizing:border-box;width:${STAGE_W}px;height:${STAGE_H}px;position:relative;overflow:hidden;}
  [contenteditable]{outline:none;cursor:text;}
  ${DECK_ASSET_FALLBACK_CSS}
</style>
</head><body>${sectionHtml || ''}${RUNTIME}</body></html>`
}

const HtmlSlideEditor = forwardRef(function HtmlSlideEditor(
  { html, template, title = 'slide', className = '', background = '#0e1a1f', tool = 'select', onSelect, onDeselect, onChange, onContextMenu, onToolDone, onDismissMenu },
  ref
) {
  const wrapRef = useRef(null)
  const frameRef = useRef(null)
  const [scale, setScale] = useState(0.5)
  const tokenStyle = useMemo(() => buildDeckTokenStyle(template), [template])
  const assetMap = useMemo(() => buildDeckAssetMap(template), [template])
  // srcDoc rebuilds only when HTML changes from OUTSIDE (slide switch, AI tweak,
  // undo/redo through the parent). Self-originated edits echo back and must not
  // reset the doc — track the last html we emitted and skip re-render on a match.
  const lastEmitted = useRef(html)
  const [srcHtml, setSrcHtml] = useState(html)
  useEffect(() => {
    if (html !== lastEmitted.current) {
      setSrcHtml(html)
      lastEmitted.current = html
    }
  }, [html])
  // resolve DS asset ids to real art for the editable view, but KEEP the marker
  // so serialize() can strip the baked src and store the symbolic id (WYSIWYG in
  // the editor, small/re-themeable on disk).
  const srcDoc = useMemo(
    () => buildEditableSrcDoc(resolveDeckAssets(srcHtml, assetMap, { keepMarker: true }), tokenStyle),
    [srcHtml, assetMap, tokenStyle]
  )

  useEffect(() => {
    if (!wrapRef.current) return
    const el = wrapRef.current
    const update = () => setScale(el.clientWidth / STAGE_W)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // push the active tool into the frame whenever it changes
  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage({ prism: true, kind: 'tool', tool }, '*')
  }, [tool, srcDoc])

  useEffect(() => {
    const onMsg = (e) => {
      const m = e.data
      if (!m || !m.prism || e.source !== frameRef.current?.contentWindow) return
      if (m.kind === 'select') onSelect?.(m.paths, m.info)
      else if (m.kind === 'deselect') onDeselect?.()
      else if (m.kind === 'contextmenu') {
        // translate iframe-local coords to parent viewport (iframe is scaled)
        const rect = frameRef.current.getBoundingClientRect()
        onContextMenu?.({ x: rect.left + m.x * scale, y: rect.top + m.y * scale, paths: m.paths })
      } else if (m.kind === 'toolDone') onToolDone?.()
      else if (m.kind === 'dismissMenu') onDismissMenu?.()
      else if (m.kind === 'html') {
        lastEmitted.current = m.html
        onChange?.(m.html)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [onSelect, onDeselect, onChange, onContextMenu, onToolDone, onDismissMenu, scale])

  const post = (msg) => frameRef.current?.contentWindow?.postMessage({ prism: true, ...msg }, '*')
  useImperativeHandle(ref, () => ({
    applyStyle: (paths, style) => post({ kind: 'applyStyle', paths, style }),
    setText: (path, text) => post({ kind: 'setText', path, text }),
    setAttr: (path, attr, value) => post({ kind: 'setAttr', path, attr, value }),
    select: (paths) => post({ kind: 'select', paths }),
    clear: () => post({ kind: 'clear' }),
    op: (op, paths) => post({ kind: 'op', op, paths }),
    move: (from, to, position) => post({ kind: 'move', from, to, position }),
    paste: (clips) => post({ kind: 'paste', clips }),
    createImage: (dataUrl, w, h) => post({ kind: 'createImage', dataUrl, w, h }),
    setHtml: (html, silent) => post({ kind: 'setHtml', html, silent }),
    setTool: (t) => post({ kind: 'tool', tool: t }),
  }))

  return (
    <div ref={wrapRef} className={`w-full overflow-hidden ${className}`} style={{ aspectRatio: '16/9', background }}>
      <iframe
        ref={frameRef}
        title={title}
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        className="border-0 origin-top-left"
        style={{ width: STAGE_W, height: STAGE_H, transform: `scale(${scale})` }}
      />
    </div>
  )
})

export default HtmlSlideEditor
