# Draft-First Outreach

Agentdiff outreach is approval-gated.

The local draft generator can research from user-provided JSON context and create a queue of email, DM, and GitHub comment drafts. It does not send messages, scrape private data, or post to any external service.

Run:

```bash
node scripts/outreach/draft.js docs/outreach-targets.example.json
```

Output:

```txt
.agentdiff/outreach/drafts.md
```

Workflow:

1. Add target context to a JSON file.
2. Generate drafts.
3. Review manually.
4. Send manually if appropriate.

Generated outreach queues are ignored by git.
