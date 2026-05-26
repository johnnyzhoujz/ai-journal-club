export function splitSqlStatements(sqlText: string) {
  const statements: string[] = [];
  let statementStart = 0;
  let i = 0;
  let state: "normal" | "singleQuote" | "doubleQuote" | "lineComment" | "blockComment" =
    "normal";
  let dollarQuoteTag: string | null = null;

  while (i < sqlText.length) {
    const char = sqlText[i];
    const next = sqlText[i + 1];

    if (dollarQuoteTag) {
      if (sqlText.startsWith(dollarQuoteTag, i)) {
        i += dollarQuoteTag.length;
        dollarQuoteTag = null;
        continue;
      }
      i += 1;
      continue;
    }

    if (state === "lineComment") {
      if (char === "\n") {
        state = "normal";
      }
      i += 1;
      continue;
    }

    if (state === "blockComment") {
      if (char === "*" && next === "/") {
        state = "normal";
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (state === "singleQuote") {
      if (char === "'" && next === "'") {
        i += 2;
        continue;
      }
      if (char === "'") {
        state = "normal";
      }
      i += 1;
      continue;
    }

    if (state === "doubleQuote") {
      if (char === '"' && next === '"') {
        i += 2;
        continue;
      }
      if (char === '"') {
        state = "normal";
      }
      i += 1;
      continue;
    }

    if (char === "-" && next === "-") {
      state = "lineComment";
      i += 2;
      continue;
    }

    if (char === "/" && next === "*") {
      state = "blockComment";
      i += 2;
      continue;
    }

    if (char === "'") {
      state = "singleQuote";
      i += 1;
      continue;
    }

    if (char === '"') {
      state = "doubleQuote";
      i += 1;
      continue;
    }

    if (char === "$") {
      const dollarQuoteMatch = sqlText
        .slice(i)
        .match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (dollarQuoteMatch) {
        dollarQuoteTag = dollarQuoteMatch[0];
        i += dollarQuoteTag.length;
        continue;
      }
    }

    if (char === ";") {
      const statement = sqlText.slice(statementStart, i).trim();
      if (statement) {
        statements.push(statement);
      }
      statementStart = i + 1;
    }

    i += 1;
  }

  const finalStatement = sqlText.slice(statementStart).trim();
  if (finalStatement) {
    statements.push(finalStatement);
  }

  return statements;
}
