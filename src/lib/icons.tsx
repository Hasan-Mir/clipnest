import React from "react";

const P: Record<string, string> = {
  search: "M11 4a7 7 0 1 0 4.2 12.6l4.1 4.1 1.4-1.4-4.1-4.1A7 7 0 0 0 11 4zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10z",
  gear: "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zm8.4 5.1-.1-1.2 1.7-1.3-1.8-3.1-2 .8a7 7 0 0 0-1-.6l-.3-2.1h-3.6l-.3 2.1c-.4.2-.7.4-1 .6l-2-.8-1.8 3.1 1.7 1.3-.1 1.2.1 1.2-1.7 1.3 1.8 3.1 2-.8c.3.2.7.4 1 .6l.3 2.1h3.6l.3-2.1c.4-.2.7-.4 1-.6l2 .8 1.8-3.1-1.7-1.3z",
  close: "M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6z",
  dots: "M5 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z",
  pin: "M14 3l7 7-2 1-3.5 3.5L16 19l-2 .5-4-4-5.5 5.5-1-1L8 14.5 4 10.5l.5-2 4.5.5L12.5 5.5z",
  tag: "M3 12V4h8l10 10-8 8zm4-5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z",
  trash: "M9 3h6l1 2h4v2H4V5h4zM6 9h12l-1 12H7z",
  edit: "M4 17.3V20h2.7L18 8.7 15.3 6zM19.7 7a1 1 0 0 0 0-1.4l-1.3-1.3a1 1 0 0 0-1.4 0l-1.1 1.1L18.6 8z",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm-1 4h2v2h-2zm0 4h2v6h-2z",
  copy: "M8 3h10a2 2 0 0 1 2 2v12h-2V5H8zM5 7h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z",
  eye: "M12 5c5 0 9 4.5 10 7-1 2.5-5 7-10 7S3 14.5 2 12c1-2.5 5-7 10-7zm0 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
  bolt: "M13 2 4 14h6l-1 8 9-12h-6z",
  merge: "M6 3v6a4 4 0 0 0 4 4h4v3l5-4.5L14 7v3h-4a1 1 0 0 1-1-1V3z",
  pause: "M7 5h4v14H7zm6 0h4v14h-4z",
  plus: "M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z",
  up: "M12 8l6 6-1.4 1.4L12 10.8l-4.6 4.6L6 14z",
  list: "M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z",
};

export function Icon({ name, size = 14 }: { name: keyof typeof P | string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d={P[name] || ""} />
    </svg>
  );
}
