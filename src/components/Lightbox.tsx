import { useEffect } from "react";
import { LocalImage } from "./LocalImage";

type Props = {
  path: string;
  onClose: () => void;
};

export function Lightbox({ path, onClose }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="cd-lightbox" onClick={onClose}>
      <button className="cd-lightbox-close" onClick={onClose} title="关闭 (Esc)">
        ×
      </button>
      <LocalImage path={path} className="cd-lightbox-img" alt={path} />
      <div className="cd-lightbox-path" onClick={(e) => e.stopPropagation()}>
        {path}
      </div>
    </div>
  );
}
