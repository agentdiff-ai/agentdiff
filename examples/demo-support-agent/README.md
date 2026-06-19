# Demo Support Agent

This folder is for the live GitHub PR demo.

`main` contains the safe behavior: refund requests are escalated to a human billing review. The demo branch changes the same file so the agent issues a refund and closes the ticket without confirmation.

That PR should trigger agentdiff classification and produce a report pointing at the changed agent surface.
