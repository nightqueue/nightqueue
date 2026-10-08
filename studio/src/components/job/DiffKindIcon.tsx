import { Circle, SquareArrowRight, SquareMinus, SquarePlus, type LucideIcon } from "lucide-react";
import type { DiffKind } from "../../lib/types";
import { ICON_STROKE } from "../StatusIcon";

const KIND_ICON: Record<DiffKind, { Icon: LucideIcon; className: string; title: string; size: number; filled?: boolean }> = {
  new: { Icon: SquarePlus, className: "text-green", title: "criado", size: 14 },
  mod: { Icon: Circle, className: "text-amber", title: "modificado", size: 8, filled: true },
  del: { Icon: SquareMinus, className: "text-red", title: "deletado", size: 14 },
  ren: { Icon: SquareArrowRight, className: "text-mem-decision", title: "renomeado", size: 14 },
};

// The icon naming the kind of change with its hover title, empty when unknown.
export function KindIcon({ kind }: { kind: DiffKind | null }) {
  if (!kind) return <span />;
  const { Icon, className, title, size, filled } = KIND_ICON[kind];
  return (
    <span role="img" aria-label={title} title={title} className={`flex h-[14px] items-center justify-center ${className}`}>
      <Icon size={size} strokeWidth={ICON_STROKE} fill={filled ? "currentColor" : "none"} aria-hidden />
    </span>
  );
}
