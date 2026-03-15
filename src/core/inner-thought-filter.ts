/**
 * Streaming state machine that intercepts <inner_thought>...</inner_thought> tags
 * from RP Agent text output, preventing thought content from being yielded to users
 * while capturing it for storage in the private memory layer.
 *
 * Four states:
 *   public       → normal text, pass through
 *   in_open_tag  → accumulating potential <inner_thought> opening tag
 *   in_thought   → inside thought block, all text captured privately
 *   in_close_tag → accumulating potential </inner_thought> closing tag
 */

const OPEN_TAG = "<inner_thought>";
const CLOSE_TAG = "</inner_thought>";

type FilterState = "public" | "in_open_tag" | "in_thought" | "in_close_tag";

export type FeedResult = {
  publicText: string;
};

export class InnerThoughtFilter {
  private state: FilterState = "public";
  private tagBuffer = "";
  private thoughtBuffer = "";

  /** All completed thought blocks captured so far. */
  readonly completedThoughts: string[] = [];

  /**
   * Feed a chunk of streamed text. Returns the public portion that should
   * be yielded to the user. Thought text is silently captured.
   */
  feed(text: string): FeedResult {
    let publicText = "";

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      switch (this.state) {
        case "public":
          if (ch === "<") {
            this.state = "in_open_tag";
            this.tagBuffer = "<";
          } else {
            publicText += ch;
          }
          break;

        case "in_open_tag":
          this.tagBuffer += ch;
          if (OPEN_TAG.startsWith(this.tagBuffer)) {
            // Still a valid prefix of <inner_thought>
            if (this.tagBuffer === OPEN_TAG) {
              // Full match — enter thought mode
              this.state = "in_thought";
              this.tagBuffer = "";
              this.thoughtBuffer = "";
            }
          } else {
            // Diverged — not an inner_thought tag, release buffer as public text
            publicText += this.tagBuffer;
            this.tagBuffer = "";
            this.state = "public";
          }
          break;

        case "in_thought":
          if (ch === "<") {
            this.state = "in_close_tag";
            this.tagBuffer = "<";
          } else {
            this.thoughtBuffer += ch;
          }
          break;

        case "in_close_tag":
          this.tagBuffer += ch;
          if (CLOSE_TAG.startsWith(this.tagBuffer)) {
            if (this.tagBuffer === CLOSE_TAG) {
              // Full match — thought block complete
              this.completedThoughts.push(this.thoughtBuffer);
              this.thoughtBuffer = "";
              this.tagBuffer = "";
              this.state = "public";
            }
          } else {
            // Diverged — not a close tag, append buffer to thought and continue
            this.thoughtBuffer += this.tagBuffer;
            this.tagBuffer = "";
            this.state = "in_thought";
          }
          break;
      }
    }

    return { publicText };
  }

  /**
   * Flush any remaining buffered text at end of message.
   * Unclosed tags are released as public text (they were not real thought tags).
   */
  flush(): FeedResult {
    let publicText = "";

    switch (this.state) {
      case "in_open_tag":
        // Incomplete open tag — release as public text
        publicText = this.tagBuffer;
        break;

      case "in_thought":
        // Unclosed thought block — release open tag + content as public text
        publicText = OPEN_TAG + this.thoughtBuffer;
        break;

      case "in_close_tag":
        // Incomplete close tag inside thought — release everything as public
        publicText = OPEN_TAG + this.thoughtBuffer + this.tagBuffer;
        break;

      case "public":
        // Nothing buffered
        break;
    }

    this.state = "public";
    this.tagBuffer = "";
    this.thoughtBuffer = "";

    return { publicText };
  }
}
