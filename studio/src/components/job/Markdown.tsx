import { inlineParts, type MarkdownBlock, markdownBlocks } from "../../lib/markdown";

const CELL = "border border-line px-2 py-1 text-left align-top";

// One line of markdown as React elements: text, `code`, strong and em, and http(s) links in rich mode; never raw HTML.
function Inline({ text, rich = false }: { text: string; rich?: boolean }) {
  return (
    <>
      {inlineParts(text, { rich }).map((part, index) => {
        if (part.kind === "code") return <code key={index} className="rounded-[3px] bg-header px-1 font-mono text-sm">{part.text}</code>;
        if (part.kind === "strong") return <strong key={index}>{part.text}</strong>;
        if (part.kind === "em") return <em key={index}>{part.text}</em>;
        if (part.kind === "link") return <a key={index} href={part.href} target="_blank" rel="noopener noreferrer" className="text-[#7fb2ff] underline">{part.text}</a>;
        return <span key={index}>{part.text}</span>;
      })}
    </>
  );
}

// A pipe table as a plain bordered table whose cells are inline markdown only.
function Table({ header, rows }: { header: string[]; rows: string[][] }) {
  return (
    <div className="mb-2 overflow-x-auto">
      <table className="border-collapse text-sm">
        <thead>
          <tr>
            {header.map((cell, index) => (
              <th key={index} className={`${CELL} bg-header font-semibold`}>
                <Inline text={cell} rich />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, index) => (
                <td key={index} className={CELL}>
                  <Inline text={cell} rich />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// One markdown block as React elements.
function Block({ block, rich }: { block: MarkdownBlock; rich: boolean }) {
  if (block.kind === "heading") return <p className="m-0 mb-2 font-semibold text-fg"><Inline text={block.text} rich={rich} /></p>;
  if (block.kind === "code") return <pre className="m-0 mb-2 overflow-x-auto rounded bg-header p-2 font-mono text-sm">{block.text}</pre>;
  if (block.kind === "table") return <Table header={block.header} rows={block.rows} />;
  if (block.kind === "list") {
    const List = block.ordered ? "ol" : "ul";
    return (
      <List className={`m-0 mb-2 pl-[18px] ${block.ordered ? "list-decimal" : "list-disc"}`}>
        {block.items.map((item, index) => (
          <li key={index}>
            <Inline text={item} rich={rich} />
          </li>
        ))}
      </List>
    );
  }
  return <p className="m-0 mb-2"><Inline text={block.text} rich={rich} /></p>;
}

// A notice or brief rendered as safe markdown: React elements only, so a job's text can never inject markup; `rich` adds links and pipe tables.
export function Markdown({ source, className = "", rich = false }: { source: string; className?: string; rich?: boolean }) {
  return (
    <div className={`text-[13px] break-words text-[#d6dae3] ${className}`}>
      {markdownBlocks(source, { rich }).map((block, index) => (
        <Block key={index} block={block} rich={rich} />
      ))}
    </div>
  );
}
