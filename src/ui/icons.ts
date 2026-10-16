// Line icons (24×24, stroke = currentColor), inlined so the app works offline.
const P: Record<string, string> = {
  select: '<path d="M6 3l12 9-5.5 1.2L15 20l-2.6 1.1-2.6-6.6L6 18z"/>',
  line: '<circle cx="5" cy="19" r="1.8"/><circle cx="19" cy="5" r="1.8"/><path d="M6.3 17.7 17.7 6.3"/>',
  rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
  circle: '<circle cx="12" cy="12" r="8"/><path d="M12 12h8"/><circle cx="12" cy="12" r="1"/>',
  arc: '<path d="M5 19C5 10 10 5 19 5"/><circle cx="5" cy="19" r="1.8"/><circle cx="19" cy="5" r="1.8"/>',
  point: '<circle cx="12" cy="12" r="3"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/>',
  construction: '<path d="M4 20 20 4" stroke-dasharray="3 3"/>',
  sketch: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
  extrude: '<path d="M12 3v9M8.5 6.5 12 3l3.5 3.5"/><path d="M4 15l8-3.5 8 3.5-8 3.5z"/><path d="M4 15v3l8 3.5 8-3.5v-3"/>',
  fit: '<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/>',
  iso: '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12 4 7.5"/>',
  grid: '<path d="M4 9h16M4 15h16M9 4v16M15 4v16"/>',
  lookAt: '<rect x="5" y="5" width="14" height="14" rx="1"/><circle cx="12" cy="12" r="2.5"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-2"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h2"/>',
  check: '<path d="M5 12.5 10 17.5 19 7"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  rename: '<path d="M4 7V5h12v2M10 5v14M8 19h4"/><path d="M17 12h4M19 10v9"/>',
  menu: '<circle cx="12" cy="5" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="12" cy="19" r="1.3"/>',
  collapse: '<path d="M15 6l-6 6 6 6"/>',
  expand: '<path d="M9 6l6 6-6 6"/>',
  plane: '<path d="M3 16 9 8h12l-6 8z"/>',
  backspace: '<path d="M8 5h12v14H8l-6-7z"/><path d="M11 9l6 6M17 9l-6 6"/>',
  flip: '<path d="M8 4v16M4 8l4-4 4 4M16 20V4M12 16l4 4 4-4"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  cut: '<path d="M12 21v-9M8.5 17.5 12 21l3.5-3.5"/><path d="M4 6l8-3.5L20 6l-8 3.5z"/>',
  intersect: '<circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/>',
  pushpull: '<path d="M4 14l8-3.5 8 3.5-8 3.5z"/><path d="M12 10.5V3M9 6l3-3 3 3"/><path d="M12 17.5V21"/>',
  shell: '<path d="M4 8l8-4 8 4v8l-8 4-8-4z"/><path d="M7 9.5l5-2.5 5 2.5v5l-5 2.5-5-2.5z"/>',
  home: '<path d="M4 11 12 4l8 7"/><path d="M6 10v10h12V10"/><path d="M10 20v-5h4v5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
};

export type IconName = keyof typeof P;

export function icon(name: IconName | string, size = 22): string {
  const body = P[name] ?? "";
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
