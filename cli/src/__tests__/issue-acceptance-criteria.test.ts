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

  it("keeps later sections after an unclosed code fence", () => {
    const out = withAcceptanceCriteria("## Acceptance Criteria\n\n- a\n\n```\ncode\n\n## Notes\n\nkeep", AC);
    expect(out).toBe("## Acceptance Criteria\n\n- new\n\n## Notes\n\nkeep");
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
  ])("keeps later sections after an unclosed HTML block: %s", (block) => {
    const out = withAcceptanceCriteria(`## Acceptance Criteria\n\n- a\n\n${block}\n\n## Notes\n\nkeep`, AC);
    expect(out).toBe("## Acceptance Criteria\n\n- new\n\n## Notes\n\nkeep");
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

  it("treats lone CR as a line ending", () => {
    const out = withAcceptanceCriteria("## Acceptance Criteria\r\r- a\r\r## Notes\r\rkeep", AC);
    expect(out).toBe("## Acceptance Criteria\n\n- new\n\n## Notes\n\nkeep");
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
});
