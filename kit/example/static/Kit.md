# Kit

A kit is the functional unit of Harbors. You can think of a kit as a complete APP.

The framework allows registering multiple kits, which cannot share with each other and are isolated from one another. This design allows Harbors to serve as a mini-program base, where each registered kit inside is a mini-program.

Kit registration information includes:

- Window basic information, startup HTML file, startup size

- Layout information, by preset different layout information, you can quickly open windows with different functions

- Plugins, the basic functional unit, a kit usually contains multiple plugins
