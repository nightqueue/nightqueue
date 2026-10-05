import { type KeyboardEvent, useState } from "react";
import type { Project } from "../lib/types";
import { FIELD_CLASS } from "./ui";

interface ProjectPickerProps {
  id: string;
  projects: Project[];
  value: string;
  onChange: (name: string) => void;
}

const LIST_ID_SUFFIX = "-list";

// The project's two lines: its name in bold and its path small and muted below.
function ProjectLines({ project }: { project: Project }) {
  return (
    <span className="flex min-w-0 flex-col text-left">
      <span className="truncate font-semibold text-fg">{project.name}</span>
      {project.path && <span className="truncate font-mono text-[11px] text-muted">{project.path}</span>}
    </span>
  );
}

// The open list of projects, the active one highlighted, picked by click.
function ProjectOptions({ listId, projects, value, active, onPick }: { listId: string; projects: Project[]; value: string; active: number; onPick: (name: string) => void }) {
  return (
    <ul id={listId} role="listbox" aria-label="projects" className="absolute top-full right-0 left-0 z-10 m-0 mt-1 max-h-64 list-none overflow-auto rounded-md border border-line bg-header p-1 shadow-lg">
      {projects.map((project, index) => (
        <li
          key={project.id}
          role="option"
          aria-selected={project.name === value}
          className={`cursor-pointer rounded px-2 py-1.5 ${index === active ? "bg-row-line" : "hover:bg-row-line"}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(project.name)}
        >
          <ProjectLines project={project} />
        </li>
      ))}
    </ul>
  );
}

// The index the arrow keys move the active option to, kept inside the list.
function movedIndex(key: string, active: number, count: number): number {
  if (key === "ArrowDown") return Math.min(active + 1, count - 1);
  if (key === "ArrowUp") return Math.max(active - 1, 0);
  return active;
}

// A project select whose options show the name in bold and the path below; arrows, Enter and Escape drive it.
export function ProjectPicker({ id, projects, value, onChange }: ProjectPickerProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const selected = projects.find((project) => project.name === value) ?? null;
  const listId = `${id}${LIST_ID_SUFFIX}`;
  const openList = () => {
    setActive(Math.max(projects.findIndex((project) => project.name === value), 0));
    setOpen(true);
  };
  const pick = (name: string) => {
    onChange(name);
    setOpen(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
    event.preventDefault();
    if (!open) return openList();
    if (event.key === "Enter") return pick(projects[active]?.name ?? value);
    setActive(movedIndex(event.key, active, projects.length));
  };
  return (
    <div className="relative">
      <button
        id={id}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        className={`${FIELD_CLASS} flex min-h-9 w-full items-center px-2.5 py-1.5`}
        onClick={() => (open ? setOpen(false) : openList())}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      >
        {selected ? <ProjectLines project={selected} /> : <span className="text-muted">choose a project</span>}
        <span className="ml-auto pl-2 text-muted" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && <ProjectOptions listId={listId} projects={projects} value={value} active={active} onPick={pick} />}
    </div>
  );
}
