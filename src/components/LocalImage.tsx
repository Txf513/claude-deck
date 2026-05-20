import { useEffect, useState } from "react";
import { readImageDataUrl } from "../lib/pty";

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

async function load(path: string): Promise<string> {
  const cached = cache.get(path);
  if (cached) return cached;
  let p = inflight.get(path);
  if (!p) {
    p = readImageDataUrl(path)
      .then((url) => {
        cache.set(path, url);
        return url;
      })
      .finally(() => inflight.delete(path));
    inflight.set(path, p);
  }
  return p;
}

type Props = {
  path: string;
  className?: string;
  alt?: string;
  onClick?: (e: React.MouseEvent<HTMLImageElement>) => void;
};

export function LocalImage({ path, className, alt, onClick }: Props) {
  const [src, setSrc] = useState<string | null>(() => cache.get(path) ?? null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (cache.has(path)) {
      setSrc(cache.get(path)!);
      return;
    }
    let cancelled = false;
    setSrc(null);
    setError(false);
    load(path)
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (error) {
    return (
      <span className={`${className ?? ""} cd-img-fallback`} title={path}>
        🖼
      </span>
    );
  }
  if (!src) {
    return (
      <span className={`${className ?? ""} cd-img-loading`} title={path}>
        ⏳
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={alt ?? path}
      className={className}
      onClick={onClick}
      onError={() => setError(true)}
    />
  );
}
