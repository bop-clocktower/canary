---
type: business_rule
domain: strategy
source: STRATEGY.md
---

# Not working on

Company-specific content of any kind — client names, internal domains,
proprietary skills, populated company.json. This repo is the open-core generic
engine; org-specific content lives only in a private overlay discovered at
runtime via `.canary/skills/`, enforced by the internal-hostname and
company-denylist guard described in AGENTS.md.
