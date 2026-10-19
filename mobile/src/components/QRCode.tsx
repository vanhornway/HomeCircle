import React, { useMemo } from 'react';
import Svg, { Path, Rect } from 'react-native-svg';
import createQR from 'qrcode-generator';

/** QR code rendered as one SVG path (no native module, works offline). */
export function QRCode({ value, size = 220 }: { value: string; size?: number }) {
  const { d, count } = useMemo(() => {
    const qr = createQR(0, 'M');
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    let path = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c + 2} ${r + 2}h1v1h-1z`;
    }
    return { d: path, count: n + 4 };
  }, [value]);
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${count} ${count}`}>
      <Rect width={count} height={count} fill="#fff" />
      <Path d={d} fill="#000" />
    </Svg>
  );
}
