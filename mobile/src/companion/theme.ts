// The Elderly Companion app's look (designs 01–09): warm paper, big shapes,
// strong outlines, one green for calling, red only for SOS.
export const C = {
  bg: '#FBF7F0',
  ink: '#1B1B1F',
  muted: '#5B5750',
  green: '#1F7A4D',
  red: '#B42318',
  orange: '#D95B35',
  amber: '#9A3412',
  soft: '#EFEAE1',
  dot: '#C9C4BA',
  care: '#F9D9D3',
  kids: '#FCE7B2',
  white: '#FFFFFF',
};

/** Tile colours for people without a photo, picked by their place on the page. */
export const TILE_COLORS = ['#E9C46A', '#F4A261', '#A8DADC', '#CDB4DB', '#B5D99C', '#F2B5C4'];

/** Urdu in Nastaliq (bundled, loaded in companion/_layout). Needs generous line height. */
export const URDU = { fontFamily: 'NotoNastaliqUrdu_600SemiBold', writingDirection: 'rtl', textAlign: 'right' } as const;

/** Whether a name is in Urdu (Arabic script), to set it in Nastaliq. */
export const isUrdu = (s: string) => /[\u0600-\u06FF]/.test(s);
