import { inlineParts, type MarkdownBlock, markdownBlocks } from "../../lib/markdown";

// One line of markdown as React elements: text, `code`, strong and em; never raw HTML.
function Inline({ text }: { text: string }) {
  return (
    <>
      {inlineParts(text).map((part, index) => {
        if (part.kind === "code") return <code key={index} className="rounded-[3px] bg-header px-1 font-mono text-sm">{part.text}</code>;
        if (part.kind === "strong") return <strong key={index}>{part.text}</strong>;
        if (part.kind === "em") return <em key={index}>{part.text}</em>;
        return <span key={index}>{part.text}</span>;
      })}
    </>
  );
}

// One markdown block as React elements.
function Block({ block }: { block: MarkdownBlock }) {
  if (block.kind === "heading") return <p className="m-0 mb-2 font-semibold text-fg"><Inline text={block.text} /></p>;
  if (block.kind === "code") return <pre className="m-0 mb-2 overflow-x-auto rounded bg-header p-2 font-mono text-sm">{block.text}</pre>;
  if (block.kind === "list") {
    const List = block.ordered ? "ol" : "ul";
    return (
      <List className={`m-0 mb-2 pl-[18px] ${block.ordered ? "list-decimal" : "list-disc"}`}>
        {block.items.map((item, index) => (
          <li key={index}>
            <Inline text={item} />
          </li>
        ))}
      </List>
    );
  }
  return <p className="m-0 mb-2"><Inline text={block.text} /></p>;
}

// A notice or brief rendered as safe markdown: React elements only, so a job's text can never inject markup.
export function Markdown({ source, className = "" }: { source: string; className?: string }) {
  return (
    <div className={`text-[13px] break-words text-[#d6dae3] ${className}`}>
      {markdownBlocks(source).map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </div>
  );
}
