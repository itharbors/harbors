# Relationship Graph Focus and Curved Edges Design

**Date:** 2026-07-22

## Goal

Make dense SQLite and MySQL relationship graphs easier to read by lowering the visual weight of
all tables at rest, then bringing one selected table, its directly related tables, and their
connecting relationships into full focus. Replace orthogonal relationship lines with smooth
curves while preserving deterministic routing, self edges, parallel constraints, dragging, and
accessibility.

## Interaction decision

Three interaction models were considered:

1. **Persistent selection (chosen):** single click or Space selects a table; double-click or Enter
   opens its table structure; clicking blank canvas clears selection.
2. **Transient focus:** hover or keyboard focus highlights relationships while a click still opens
   the table. This preserves the old click action but is difficult to inspect and weak on touch.
3. **Multi-hop focus:** selecting a table highlights its full reachable component. This exposes more
   context but quickly makes ordinary schemas visually noisy.

Persistent one-hop selection provides the clearest reading state across mouse, keyboard, and touch.
It intentionally changes the single-click action; Enter remains the fastest accessible open action.

## Visual states

The existing SQLite industrial-dark and MySQL blue technical themes remain unchanged. Focus is
expressed through opacity, border emphasis, and edge weight rather than introducing a new palette.

- With no selected table, every table card is softly translucent and every edge is quiet but
  readable. Search results still use the existing, stronger dimming treatment.
- The selected table has full opacity, the strongest theme border, and `aria-pressed="true"`.
- Tables connected by an incoming or outgoing relationship also have full opacity with a quieter
  related-state border.
- Unrelated tables, edges, and relationship details remain translucent.
- Only edges incident to the selected table become fully opaque and slightly heavier.
- Hover and `:focus-visible` temporarily restore full opacity so a dimmed card never becomes hard to
  target.
- Reduced-motion mode keeps state changes immediate.

The opacity hierarchy is implemented with semantic data attributes emitted by the shared renderer:
`data-focus="selected|related|muted|idle"`. Search dimming remains a separate `data-dimmed`
attribute so both filters compose predictably.

## Shared renderer contract

`renderRelationshipView` gains `selectedTable: string | null` and
`onSelectTable(name: string | null)`. The renderer computes the selected table's direct neighbor set
from valid graph relationships and applies focus attributes to cards, SVG paths, and relationship
detail rows.

The SQLite and MySQL panels own `selectedTable` because their search, loading, and activity changes
can rebuild the shared DOM. Selection is reset when the database identity changes, is retained across
ordinary rerenders and Schema updates while the table survives, and is cleared when that table is
removed. MySQL ignores selection input while an activity overlay is active.

Table interaction becomes:

- click: select the table;
- double-click: open table structure;
- Space: select the focused table;
- Enter: open table structure;
- drag: move only, without selecting or opening;
- blank-canvas click: clear selection, but a completed pan does not clear it.

## Curved edge routing

Every non-self relationship uses a cubic Bézier path. Left-to-right relationships leave and enter
the nearest horizontal card edges. Control points use a bounded horizontal tangent based on the
distance between endpoints, producing a readable S-curve without excessive overshoot. Same-column
relationships route around the right side with two control points. Parallel relationships retain
their stable per-pair offsets, which are applied to control lanes rather than creating overlapping
curves. Self relationships keep the existing cubic loop.

The route result continues to include all endpoints and control points in its bounds, ensuring fit
and auto-arrange account for visible curve extents. Dragging a node reroutes only its incident paths
in place, as today.

## Accessibility

Cards retain `role="button"` and gain `aria-pressed`. The toolbar help text states the new controls.
The selected state does not rely on color alone: opacity, border weight, and ARIA state all change.
Keyboard focus remains visually dominant regardless of graph focus or search state.

## Testing

Shared renderer tests cover click/Space selection, double-click/Enter opening, blank-canvas clearing,
drag suppression, one-hop focus attributes, search composition, and Schema-safe selected-state
inputs. Edge tests verify cubic paths for horizontal, reverse, same-column, parallel, and self
relationships and stable bounds. SQLite and MySQL panel tests verify selection survives rerender,
clears on database changes or removed tables, and respects the MySQL activity lock. Existing drag,
cache, viewport, open-table, and accessibility tests remain green.
