// A short authentication string for a call: four words both people see,
// made from the two DTLS fingerprints (the certificates the phones made for
// this call). If both screens show the same words, the voice is going straight
// between the two phones and nobody has swapped a certificate. The signalling
// is already signed and sealed, so this is a second, human check.
import nacl from 'tweetnacl';

// 256 words, so each carries one byte of the hash. Short, common, and unlike each other when spoken.
export const SAS_WORDS = (
  'amber anchor apple arrow aspen atlas autumn badge bakery balloon bamboo banjo barn basil beacon berry ' +
  'birch biscuit blanket bloom bridge bronze brook bubble button cabin cactus camel candle canyon carrot castle ' +
  'cedar cherry circle clover cobalt comet copper coral cotton cricket crystal daisy delta desert dolphin dragon ' +
  'drum eagle ember falcon feather fern ferry fiddle field finch flame forest fossil fox garden ginger glacier ' +
  'goose grain granite grape guitar harbor hazel heron hickory honey horizon island ivory jasmine jungle kettle ' +
  'kite lagoon lantern lemon lilac linen lotus maple marble meadow melon mint mirror mosaic mountain nectar ' +
  'nickel oasis olive onion orange orchard otter paddle pansy parrot peach pearl pebble pepper piano pine planet ' +
  'plum pocket poppy prairie pumpkin quartz quill rabbit rainbow raven ribbon river robin rocket saddle saffron ' +
  'sailor salmon sandal sapphire scarlet shadow silver sketch sparrow spiral spruce squirrel stream summer sunset ' +
  'swan tangerine teapot thistle thunder tiger timber tulip tunnel turtle umbrella valley velvet violet walnut ' +
  'willow window winter wizard yellow zebra zephyr zigzag acorn almond anvil bagel basket beetle blossom bonfire ' +
  'bottle bucket butter cabbage canal cannon canoe carpet chimney cinnamon cliff cloud cocoa compass cookie ' +
  'cradle crown curtain dahlia dawn diamond dusk feast fiddler flute fountain frost galaxy garlic gazelle gift ' +
  'globe hammock harvest hedge hill hollow iceberg jacket jewel jigsaw lace ladder lark lighthouse locket magnet ' +
  'mango mitten moon muffin napkin needle orbit pancake parade pasture pillow pigeon pistachio pond puddle puzzle ' +
  'bread candy chalk chess clay clock crane doll dove ferret flint gull lamp mule owl quail rose'
).split(' ');

/** The words for one call: the same on both phones, whichever one started it. */
export function sasWords(fingerprintsA: string[], fingerprintsB: string[]): string[] {
  // Each side's fingerprints joined, then the two sides in a fixed order: A+B and B+A give the same words.
  const sides = [fingerprintsA.join(','), fingerprintsB.join(',')].sort();
  const bytes = nacl.hash(new TextEncoder().encode(`homecircle/call-sas-v1|${sides[0]}|${sides[1]}`));
  return [0, 1, 2, 3].map((i) => SAS_WORDS[bytes[i]]);
}
