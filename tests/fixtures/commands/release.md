---
description: "Create a new release with changelog and version bump"
---

Run the release process:

1. Determine the next version based on conventional commits
2. Update CHANGELOG.md
3. Bump version in package.json
4. Create git tag
5. Push tag and changes

```bash
npm version ${VERSION_TYPE} && git push --follow-tags
```
