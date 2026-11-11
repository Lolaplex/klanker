import React from "react";

/**
 * Klanker mark: the "D crew" — ten bots in a D silhouette, black on white,
 * rotated 45°. Same geometry as concepts/icon-workshop.html, tightened so it
 * still reads at 20px.
 */
const CELLS: Array<[number, number]> = [
  [0, 0],
  [0, 1],
  [0, 2],
  [0, 3],
  [0, 4],
  [1, 2],
  [2, 1],
  [2, 3],
  [3, 0],
  [3, 4],
];

interface KlankerMarkProps {
  size?: number;
  className?: string;
}

export const KlankerMark: React.FC<KlankerMarkProps> = ({ size = 20, className }) => {
  const unit = 2.2;
  const pitch = 2.5;
  const width = 3 * pitch + unit;
  const height = 4 * pitch + unit;
  const ox = (24 - width) / 2;
  const oy = (24 - height) / 2;
  const eye = unit * 0.08;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      role="img"
      aria-label="Klanker"
    >
      <rect width="24" height="24" rx="5" fill="#ffffff" />
      <g transform="rotate(45 12 12)">
        {CELLS.map(([col, row]) => {
          const x = ox + col * pitch;
          const y = oy + row * pitch;
          const cy = y + unit * 0.42;
          return (
            <g key={`${col}-${row}`}>
              <rect
                x={x}
                y={y}
                width={unit}
                height={unit}
                rx={unit * 0.3}
                fill="#000000"
              />
              <circle cx={x + unit * 0.32} cy={cy} r={eye} fill="#ffffff" />
              <circle cx={x + unit * 0.68} cy={cy} r={eye} fill="#ffffff" />
            </g>
          );
        })}
      </g>
    </svg>
  );
};
