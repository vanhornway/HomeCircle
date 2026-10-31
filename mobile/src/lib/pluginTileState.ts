// The plugin tile on the map has three sizes. Double-tap goes to the next:
// a circle with just the plugin's icon, the small tile, the big tile, and
// back to the circle. Pure, so it can be tested; the phone remembers the size
// (lib/pluginTile.ts).
export type TileView = 'circle' | 'small' | 'big';

export const TILE_VIEWS: TileView[] = ['circle', 'small', 'big'];

/** Where a double-tap goes from here. */
export function nextTileView(v: TileView): TileView {
  return v === 'circle' ? 'small' : v === 'small' ? 'big' : 'circle';
}

/** What was saved, or the circle (the default) for anything else. */
export function parseTileView(raw: unknown): TileView {
  return TILE_VIEWS.includes(raw as TileView) ? (raw as TileView) : 'circle';
}
