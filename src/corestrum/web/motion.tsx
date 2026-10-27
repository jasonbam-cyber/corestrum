import { useEffect, useRef, type ReactNode, type RefObject } from "react";

// Progressive enhancement: content is visible before JS, on focus, and with reduced motion.
function observe(elements: HTMLElement[]) {
  if (!window.IntersectionObserver || matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.input === "keyboard") return () => {};
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) {
      entry.target.setAttribute("data-visible", "true");
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.08, rootMargin: "0px 0px -16px 0px" });
  elements.forEach((element, index) => {
    if (element.dataset.visible) return;
    element.dataset.reveal = "true";
    element.style.setProperty("--reveal-delay", `${Math.min(index % 4, 3) * 40}ms`);
    observer.observe(element);
  });
  return () => { observer.disconnect(); elements.forEach(el => { el.dataset.visible = "true"; }); };
}

export function usePageMotion(ref: RefObject<HTMLElement | null>, key: unknown) {
  useEffect(() => {
    if (!ref.current) return;
    return observe(Array.from(ref.current.querySelectorAll<HTMLElement>(".panel, .agent-card, .template-card, .routine-list > article, .page-title")));
  }, [key, ref]);
}

export function Reveal({ children, className = "", delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const cleanup = observe([ref.current]);
    ref.current.style.setProperty("--reveal-delay", `${delay}ms`);
    return cleanup;
  }, []);
  return <div ref={ref} className={`reveal ${className}`}>{children}</div>;
}

export function useInputModality() {
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => { if (event.key === "Tab" || event.key.startsWith("Arrow")) document.documentElement.dataset.input = "keyboard"; };
    const pointer = () => { document.documentElement.dataset.input = "pointer"; };
    window.addEventListener("keydown", keyboard);
    window.addEventListener("pointerdown", pointer);
    return () => { window.removeEventListener("keydown", keyboard); window.removeEventListener("pointerdown", pointer); };
  }, []);
}
