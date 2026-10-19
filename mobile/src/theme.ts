import { useColorScheme } from 'react-native';

const light = {
  bg: '#F6F3EE',
  surface: '#FFFFFF',
  surface2: '#F0ECE5',
  text: '#1D2422',
  muted: '#66706C',
  line: '#E2DDD4',
  brand: '#2F7D6D',
  brandInk: '#FFFFFF',
  brandSoft: '#E1EFEB',
  accent: '#F2B84B',
  danger: '#C2412D',
  ok: '#2E9A5B',
  warnBg: '#FBE6D9',
  warnText: '#9A3D16',
  dark: false,
};

const dark: typeof light = {
  bg: '#121615',
  surface: '#1A201E',
  surface2: '#222A27',
  text: '#E9EEEC',
  muted: '#97A29E',
  line: '#2C3532',
  brand: '#5CBFA8',
  brandInk: '#0D1412',
  brandSoft: '#1E3530',
  accent: '#F2B84B',
  danger: '#EF7A66',
  ok: '#4CC27F',
  warnBg: '#3A2418',
  warnText: '#F2B08A',
  dark: true,
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}

export const LANDING_URL = 'https://homecircle.app';
