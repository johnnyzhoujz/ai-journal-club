import type { Components } from "react-markdown";

export const markdownComponents: Components = {
  h1: (props) => <h1 className="text-xl font-bold mb-4" {...props} />,
  h2: (props) => (
    <h2
      className="text-base font-semibold mt-6 mb-3 text-foreground"
      {...props}
    />
  ),
  p: (props) => (
    <p
      className="text-sm leading-relaxed mb-3 text-foreground/90"
      {...props}
    />
  ),
  a: (props) => (
    <a
      className="text-blue-600 dark:text-blue-400 font-medium underline underline-offset-2 decoration-blue-600/40 dark:decoration-blue-400/40 hover:decoration-blue-600 dark:hover:decoration-blue-400"
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    />
  ),
  strong: (props) => (
    <strong className="font-semibold text-foreground" {...props} />
  ),
  hr: () => <hr className="my-5 border-border" />,
  ul: (props) => <ul className="list-disc pl-5 mb-3 text-sm" {...props} />,
  ol: (props) => <ol className="list-decimal pl-5 mb-3 text-sm" {...props} />,
  li: (props) => <li className="mb-1" {...props} />,
};
