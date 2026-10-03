import { Card, CardEmpty } from "./Card";

// The files touched card: the names the run recorded or edited, names only.
export function FilesCard({ files }: { files: string[] }) {
  const names = Array.isArray(files) ? files : [];
  return (
    <Card label="files" title={`Files touched · ${names.length}`}>
      {names.length === 0 ? (
        <CardEmpty>None yet.</CardEmpty>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-[3px] p-0 font-mono text-sm break-all text-note">
          {names.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}
