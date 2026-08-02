export const BOX_HEIGHT = 4;
export const GAP_X = 7;
export const GAP_Y = 1;
function boxWidth(id, typeName) {
    return Math.max(id.length + 2, typeName.length) + 6;
}
/**
 * Left-to-right auto-layout in dependency order: a node's layer is the
 * longest path from any root, so every node is drawn after all of its
 * dependencies.
 */
export function computeLayout(workflow, overrides) {
    const layerOf = new Map();
    for (const id of workflow.order) {
        const deps = workflow.graph.directDependencies(id);
        const layer = deps.length === 0 ? 0 : Math.max(...deps.map((d) => layerOf.get(d) + 1));
        layerOf.set(id, layer);
    }
    const layers = new Map();
    for (const id of workflow.order) {
        const l = layerOf.get(id);
        if (!layers.has(l))
            layers.set(l, []);
        layers.get(l).push(id);
    }
    const widths = new Map();
    for (const node of workflow.nodes) {
        widths.set(node.id, boxWidth(node.id, node.type.displayName));
    }
    const boxes = new Map();
    let x = 0;
    const layerCount = Math.max(...layers.keys()) + 1;
    for (let l = 0; l < layerCount; l++) {
        const ids = layers.get(l) ?? [];
        const layerWidth = Math.max(...ids.map((id) => widths.get(id)), 0);
        ids.forEach((id, row) => {
            boxes.set(id, {
                id,
                x,
                y: row * (BOX_HEIGHT + GAP_Y),
                w: widths.get(id),
                h: BOX_HEIGHT,
                layer: l,
            });
        });
        x += layerWidth + GAP_X;
    }
    if (overrides) {
        for (const [id, { dx, dy }] of overrides) {
            const box = boxes.get(id);
            if (box) {
                box.x = Math.max(0, box.x + dx);
                box.y = Math.max(0, box.y + dy);
            }
        }
    }
    let width = 0;
    let height = 0;
    for (const box of boxes.values()) {
        width = Math.max(width, box.x + box.w);
        height = Math.max(height, box.y + box.h);
    }
    return { boxes, width, height };
}
/** Adjust viewport offsets so `box` is fully visible (focus scrolls into view). */
export function scrollIntoView(box, viewport) {
    let { ox, oy } = viewport;
    if (box.x < ox)
        ox = box.x;
    if (box.x + box.w > ox + viewport.width)
        ox = box.x + box.w - viewport.width;
    if (box.y < oy)
        oy = box.y;
    if (box.y + box.h > oy + viewport.height)
        oy = box.y + box.h - viewport.height;
    return { ox: Math.max(0, ox), oy: Math.max(0, oy) };
}
export function hitTest(layout, x, y) {
    for (const box of layout.boxes.values()) {
        if (x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h)
            return box.id;
    }
    return null;
}
//# sourceMappingURL=layout.js.map