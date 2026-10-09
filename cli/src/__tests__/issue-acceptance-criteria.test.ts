import { describe, expect, it } from "vitest";
import { withAcceptanceCriteria } from "../commands/client/issue.js";

const AC = ["new"];

describe("withAcceptanceCriteria edge cases", () => {
  it("replaces every AC section, keeping the first position", () => {
    const out = withAcceptanceCriteria("Intro\n\n## Acceptance Criteria\n\n- a\n\n## Notes\n\nkeep\n\n## Acceptance Criteria\n\n- b", AC);
    expect(out).toBe("Intro\n\n## Acceptance Criteria\n\n- new\n\n## Notes\n\nkeep");
  });

  it("keeps content after a setext heading", () => {
    const out = withAcceptanceCriteria("## Acceptance Criteria\n\n- a\n\nNotes\n=====\n\nkeep", AC);
    expect(out).toBe("## Acceptance Criteria\n\n- new\n\nNotes\n=====\n\nkeep");
  });

  it("keeps content after an indented ## heading", () => {
    const out = withAcceptanceCriteria("## Acceptance Criteria\n\n- a\n\n   ## Notes\n\nkeep", AC);
    expect(out).toBe("## Acceptance Criteria\n\n- new\n\n   ## Notes\n\nkeep");
  });

  it("ignores an AC heading inside an HTML comment", () => {
    const src = "<!--\n## Acceptance Criteria\n-->\n\ntext";
    expect(withAcceptanceCriteria(src, AC)).toBe(`${src}\n\n## Acceptance Criteria\n\n- new`);
  });

  it.each(["## Acceptance Criteria (v1)", "## Acceptance Criteria ##", "## acceptance criteria"])(
    "matches heading variant %s",
    (heading) => {
      expect(withAcceptanceCriteria(`${heading}\n\n- old`, AC)).toBe("## Acceptance Criteria\n\n- new");
    },
  );

  it("keeps CRLF line endings consistent", () => {
    const out = withAcceptanceCriteria("Intro\r\n\r\n## Acceptance Criteria\r\n\r\n- a\r\n\r\n## Notes\r\n\r\nkeep", AC);
    expect(out).toBe("Intro\r\n\r\n## Acceptance Criteria\r\n\r\n- new\r\n\r\n## Notes\r\n\r\nkeep");
    expect(out!.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("does not treat a list item before --- as a setext heading", () => {
    const out = withAcceptanceCriteria("## Acceptance Criteria\n\n- a\n---\n\n## Notes", AC);
    expect(out).toBe("## Acceptance Criteria\n\n- new\n\n## Notes");
  });

  it("does not treat <!-- inside inline code as a comment", () => {
    const out = withAcceptanceCriteria("Use `<!--` here.\n\n## Acceptance Criteria\n\n- a\n\n## Notes\n\nkeep", AC);
    expect(out).toBe("Use `<!--` here.\n\n## Acceptance Criteria\n\n- new\n\n## Notes\n\nkeep");
  });

  it("keeps later sections after an unclosed mid-line <!--", () => {
    const out = withAcceptanceCriteria("## Acceptance Criteria\n\n- a <!-- todo\n\n## Notes\n\nkeep", AC);
    expect(out).toBe("## Acceptance Criteria\n\n- new\n\n## Notes\n\nkeep");
  });

  it("keeps later sections after an unclosed <!-- in an indented code block", () => {
    const out = withAcceptanceCriteria("## Acceptance Criteria\n\n    <!-- todo\n\n## Notes\n\nkeep", AC);
    expect(out).toBe("## Acceptance Criteria\n\n- new\n\n## Notes\n\nkeep");
  });

  it("recognizes the AC heading after an unclosed mid-line <!--", () => {
    const out = withAcceptanceCriteria("intro <!-- x\n\n## Acceptance Criteria\n\n- a", AC);
    expect(out).toBe("intro <!-- x\n\n## Acceptance Criteria\n\n- new");
  });
  // RK9-466: the CommonMark parser decides what is a heading, a comment or a code block.
  it("keeps later sections after an unclosed <!-- on a list item continuation line", () => {
    const out = withAcceptanceCriteria("## Acceptance Criteria\n\n- a\n  <!-- todo\n\n## Notes\n\nkeep", AC);
    expect(out).toBe("## Acceptance Criteria\n\n- new\n\n## Notes\n\nkeep");
  });

  it("replaces the AC section after an unclosed line-start <!-- instead of adding a second one", () => {
    const out = withAcceptanceCriteria("<!-- x\n\n## Acceptance Criteria\n\n- a", AC);
    expect(out).toBe("<!-- x\n\n## Acceptance Criteria\n\n- new");
  });

  it("does not treat --> ## Notes on the closing comment line as a heading", () => {
    const out = withAcceptanceCriteria("## Acceptance Criteria\n\n- a\n\n<!-- c\n--> ## Notes\n\n## Real\n\nkeep", AC);
    expect(out).toBe("## Acceptance Criteria\n\n- new\n\n## Real\n\nkeep");
  });

  it("keeps the text before a closed comment that ends with --> ## Notes", () => {
    const src = "<!-- c\n--> ## Notes\n\nkeep";
    expect(withAcceptanceCriteria(`${src}\n\n## Acceptance Criteria\n\n- a`, AC)).toBe(
      `${src}\n\n## Acceptance Criteria\n\n- new`,
    );
  });

  it("keeps an unclosed code fence and everything after it", () => {
    const out = withAcceptanceCriteria("## Acceptance Criteria\n\n- a\n\n```\ncode\n\n## Notes\n\nkeep", AC);
    expect(out).toBe("## Acceptance Criteria\n\n- new\n\n```\ncode\n\n## Notes\n\nkeep");
  });

  it("keeps an AC-like heading inside an unclosed fence after a visible AC section", () => {
    const tail = "## Notes\n\n```md\n## Acceptance Criteria\n- example\nmore code";
    const out = withAcceptanceCriteria(`## Acceptance Criteria\n\n- a\n\n${tail}`, AC);
    expect(out).toBe(`## Acceptance Criteria\n\n- new\n\n${tail}`);
    expect(withAcceptanceCriteria(out, AC)).toBe(out);
  });

  it("replaces the AC section after an unclosed code fence", () => {
    const out = withAcceptanceCriteria("```\ncode\n\n## Acceptance Criteria\n\n- a", AC);
    expect(out).toBe("```\ncode\n\n## Acceptance Criteria\n\n- new");
  });

  it("ignores an AC heading inside a closed code fence", () => {
    const src = "~~~md\n## Acceptance Criteria\n~~~\n\ntext";
    expect(withAcceptanceCriteria(src, AC)).toBe(`${src}\n\n## Acceptance Criteria\n\n- new`);
  });

  it("matches a setext AC heading", () => {
    const out = withAcceptanceCriteria("Acceptance Criteria\n-------------------\n\n- a\n\n## Notes\n\nkeep", AC);
    expect(out).toBe("## Acceptance Criteria\n\n- new\n\n## Notes\n\nkeep");
  });

  it("keeps a level 3 subsection inside the AC section and stops at the next level 1 heading", () => {
    const out = withAcceptanceCriteria("## Acceptance Criteria\n\n### Sub\n\n- a\n\n# Top\n\nkeep", AC);
    expect(out).toBe("## Acceptance Criteria\n\n- new\n\n# Top\n\nkeep");
  });

  it("ignores AC headings nested in a blockquote or list", () => {
    const src = "> ## Acceptance Criteria\n\n- ## Acceptance Criteria";
    expect(withAcceptanceCriteria(src, AC)).toBe(`${src}\n\n## Acceptance Criteria\n\n- new`);
  });
  it("keeps a level 2 heading nested in a blockquote after the AC section", () => {
    const out = withAcceptanceCriteria("## Acceptance Criteria\n\n- a\n\n> ## Quote\n\nkeep", AC);
    expect(out).toBe("## Acceptance Criteria\n\n- new\n\n> ## Quote\n\nkeep");
  });
  it.each([
    "<pre> blocks must be escaped",
    "<script> tags in comments must be escaped.",
    "<textarea> grows",
    "<?php\necho 1;",
    "<![CDATA[ raw",
    "<!DOCTYPE html",
    "<pre\nx",
    "<script",
  ])("keeps an unclosed HTML block and everything after it: %j", (block) => {
    const out = withAcceptanceCriteria(`## Acceptance Criteria\n\n- a\n\n${block}\n\n## Notes\n\nkeep`, AC);
    expect(out).toBe(`## Acceptance Criteria\n\n- new\n\n${block}\n\n## Notes\n\nkeep`);
  });

  it("replaces the AC section after an unclosed <pre without >", () => {
    const out = withAcceptanceCriteria("<pre\nx\n\n## Acceptance Criteria\n\n- a\n\n## Notes\n\nkeep", AC);
    expect(out).toBe("<pre\nx\n\n## Acceptance Criteria\n\n- new\n\n## Notes\n\nkeep");
  });

  it("replaces an AC heading nested on its own line in a list item", () => {
    const out = withAcceptanceCriteria("- item\n\n  ## Acceptance Criteria\n\n  - a", AC);
    expect(out).toBe("- item\n\n## Acceptance Criteria\n\n- new");
  });

  it("does not overflow the stack on deeply nested blockquotes", () => {
    expect(() => withAcceptanceCriteria(`${"> ".repeat(6000)}x`, AC)).not.toThrow();
  });

  it("replaces the AC section after an unclosed <style> block", () => {
    const out = withAcceptanceCriteria("<style> blocks leak.\n\n## Acceptance Criteria\n\n- a", AC);
    expect(out).toBe("<style> blocks leak.\n\n## Acceptance Criteria\n\n- new");
  });

  it.each([
    "Sanitize <pre> output.\n\n<pre> blocks must be escaped",
    "<!-- x\n\nIntro",
    "```\ncode",
    "    ## Acceptance Criteria\n\nbody",
    "## Acceptance Criteria\n\n- a\n\n<script>\n\n## Notes\n\nkeep",
    "<pre\nx\n\n## Acceptance Criteria\n\n- a",
    "Intro\n\n<pre\n",
  ])("is idempotent for %j", (src) => {
    const once = withAcceptanceCriteria(src, AC);
    expect(withAcceptanceCriteria(once, AC)).toBe(once);
    expect(once!.match(/^## Acceptance Criteria$/gm)).toHaveLength(1);
  });

  it("keeps an indented code block indented when it appends the AC section", () => {
    const out = withAcceptanceCriteria("    ## Acceptance Criteria\n\nbody", AC);
    expect(out).toBe("    ## Acceptance Criteria\n\nbody\n\n## Acceptance Criteria\n\n- new");
  });

  it("replaces old AC items after an item that contains a heading", () => {
    const out = withAcceptanceCriteria("## Acceptance Criteria\n\n- # big\n- b\n\nafter", AC);
    expect(out).toBe("## Acceptance Criteria\n\n- new");
  });

  it("treats lone CR as a line ending and keeps it", () => {
    const out = withAcceptanceCriteria("## Acceptance Criteria\r\r- a\r\r## Notes\r\rkeep", AC);
    expect(out).toBe("## Acceptance Criteria\r\r- new\r\r## Notes\r\rkeep");
  });

  it("finds the AC section after many unclosed comment lines", () => {
    const src = `${"<!-- x\n".repeat(40)}\n## Acceptance Criteria\n\n- a`;
    expect(withAcceptanceCriteria(src, AC)!.match(/^## Acceptance Criteria$/gm)).toHaveLength(1);
  });

  it("stops rescanning after 50 unclosed blocks so the run time stays bounded", () => {
    const started = Date.now();
    withAcceptanceCriteria(`${"<!-- x\n".repeat(3000)}\n## Acceptance Criteria\n\n- a`, AC);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
  it.each([
    ["\uFEFF# Title\n\n## Acceptance Criteria\n- a\n## Notes\nkeep", "\uFEFF# Title\n\n## Acceptance Criteria\n\n- new\n\n## Notes\nkeep"],
    ["\uFEFFIntro\n## Acceptance Criteria\n- a\n\n## Notes\nkeep", "\uFEFFIntro\n\n## Acceptance Criteria\n\n- new\n\n## Notes\nkeep"],
  ])("handles a leading BOM: %j", (src, expected) => {
    expect(withAcceptanceCriteria(src, AC)).toBe(expected);
  });

  it("replaces a heading nested deeper than 3 spaces with the old AC list, like before", () => {
    const out = withAcceptanceCriteria("## Acceptance Criteria\n\n- a\n  - b\n    - c\n\n      ## Notes\n\nkeep", AC);
    expect(out).toBe("## Acceptance Criteria\n\n- new");
    expect(withAcceptanceCriteria(out, AC)).toBe(out);
  });

  it("does not take an AC heading indented 4 spaces in a list item, so later items stay", () => {
    const src = "1.  step\n\n    ## Acceptance Criteria\n\n    - a\n\n2.  step 2";
    expect(withAcceptanceCriteria(src, AC)).toBe(`${src}\n\n## Acceptance Criteria\n\n- new`);
  });
  it.each([
    ["\uFEFF<!-- x\n\n## Acceptance Criteria\n\n- a", "\uFEFF<!-- x\n\n## Acceptance Criteria\n\n- new"],
    ["\uFEFF## Acceptance Criteria\n\n- old\n\n## Notes\nkeep", "\uFEFF## Acceptance Criteria\n\n- new\n\n## Notes\nkeep"],
  ])("keeps a leading BOM before an unclosed block or AC heading: %j", (src, expected) => {
    const out = withAcceptanceCriteria(src, AC);
    expect(out).toBe(expected);
    expect(withAcceptanceCriteria(out, AC)).toBe(out);
  });

  it("is idempotent with a leading BOM and an unclosed fence", () => {
    const once = withAcceptanceCriteria("\uFEFF```\ncode", AC);
    expect(withAcceptanceCriteria(once, AC)).toBe(once);
  });

  it.each(["</details>", '<img src="x.png">', "<div>"])(
    "keeps a heading right after an HTML block line: %s",
    (html) => {
      const out = withAcceptanceCriteria(`## Acceptance Criteria\n- a\n\n${html}\n## Notes\nkeep`, AC);
      expect(out).toBe("## Acceptance Criteria\n\n- new\n\n## Notes\nkeep");
    },
  );
  it("replaces an AC heading right after an HTML block line", () => {
    const out = withAcceptanceCriteria("<details>\n\nx\n\n</details>\n## Acceptance Criteria\n- a\n\n## Notes\nkeep", AC);
    expect(out).toBe("<details>\n\nx\n\n</details>\n\n## Acceptance Criteria\n\n- new\n\n## Notes\nkeep");
    expect(withAcceptanceCriteria(out, AC)).toBe(out);
  });
  it.each([
    "Intro\n\n- step one\n- <!-- disabled for now\n  ## Acceptance Criteria\n  - old item\n  -->\n- step two\n\n## Notes\n\nkeep",
    "1. <script>\n   ## Acceptance Criteria\n   </script>\n2. visible\n\ntail",
  ])("does not split a comment or <script> block on a list marker line: %j", (src) => {
    expect(withAcceptanceCriteria(src, AC)).toBe(`${src}\n\n## Acceptance Criteria\n\n- new`);
  });

  it.each([
    "## Acceptance Criteria\n\n- a\n\n- <!-- c\n  ## Notes\n  -->\n- b\n\nkeep",
    "## Acceptance Criteria\n\n- a\n- <pre>\n  # install\n  npm i\n  </pre>\n- b\n\nkeep",
  ])("replaces a list item comment or <pre> block with the AC section: %j", (src) => {
    expect(withAcceptanceCriteria(src, AC)).toBe("## Acceptance Criteria\n\n- new");
  });
});
