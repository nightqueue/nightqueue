import { FileCheck, FileMinus, FilePlus, FileSymlink, type LucideIcon } from "lucide-react";
import { KIND_META } from "../../lib/files";
import type { DiffKind } from "../../lib/types";
import { ICON_STROKE } from "../StatusIcon";

const KIND_ICON: Record<DiffKind, LucideIcon> = {
  new: FilePlus,
  mod: FileCheck,
  del: FileMinus,
  ren: FileSymlink,
};

// The icon naming the kind of change with its hover title, empty when unknown.
export function KindIcon({ kind }: { kind: DiffKind | null | undefined }) {
  if (!kind || !KIND_META[kind]) return <span />;
  const Icon = KIND_ICON[kind];
  const { label, tone } = KIND_META[kind];
  return (
    <span role="img" aria-label={label} title={label} className={`flex h-[14px] items-center justify-center ${tone}`}>
      <Icon size={14} strokeWidth={ICON_STROKE} aria-hidden />
    </span>
  );
}
