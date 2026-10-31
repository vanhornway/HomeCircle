import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextTileView, parseTileView, type TileView } from './pluginTileState.ts';

test('double-tap goes circle → small → big → circle', () => {
  let v: TileView = 'circle';
  const seen: TileView[] = [];
  for (let i = 0; i < 6; i++) seen.push((v = nextTileView(v)));
  assert.deepEqual(seen, ['small', 'big', 'circle', 'small', 'big', 'circle']);
});

test('a saved size is restored; anything else starts as the circle', () => {
  assert.equal(parseTileView('big'), 'big');
  assert.equal(parseTileView('small'), 'small');
  assert.equal(parseTileView('circle'), 'circle');
  for (const bad of [null, undefined, '', 'huge', 3, {}]) assert.equal(parseTileView(bad), 'circle');
});
