---
'@vectojs/knowledge-graph': patch
---

Expanding an unknown id no longer materializes a phantom 'Unknown' entity. KgNeighborhood.entity is now optional (sources that don't know the id return no entity), MemoryDataSource returns no placeholder, and the model fails such expansions with a targeted error instead of permanently ingesting a fabricated node.
