/** Replies are scoped to the provider loop that asked for them. */
export class AskUserInbox {
  private readonly pending = new Map<Promise<void>, () => void>();
  private readonly replies: string[] = [];
  private closed = false;

  get hasReplies() { return this.replies.length > 0; }

  get hasWork() { return this.hasReplies || this.pending.size > 0; }

  track(reply: Promise<string>, cancel: () => void) {
    const tracked: Promise<void> = reply.then(text => {
      if (!this.closed) this.replies.push(text);
    }).catch(() => undefined).finally(() => this.pending.delete(tracked));
    this.pending.set(tracked, cancel);
    if (this.closed) cancel();
  }

  takeReplies(): string {
    if (!this.hasReplies) return '';
    return [
      'Updates to your Ask User requests. Apply the actual replies to the current task. A dismissal or expiry leaves that question unanswered.',
      ...this.replies.splice(0),
    ].join('\n');
  }

  async waitForReply(): Promise<string> {
    while (!this.hasReplies && this.pending.size) await Promise.race(this.pending.keys());
    return this.takeReplies();
  }

  close() {
    this.closed = true;
    for (const cancel of this.pending.values()) cancel();
    this.replies.length = 0;
  }
}
