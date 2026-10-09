# Java review checks

- Does the change follow the repository's conventions, and add no dependency, plugin or Java level change the task did not ask for?
- Are only language features and JDK APIs of the build's baseline used (`release`, or the stated minimum runtime)?
- Is a public or protected API changed in a way that breaks callers (source, binary or behaviour)?
- Can `null` reach a dereference, or is `null` returned where the existing contract expects a collection or `Optional`?
- Are exceptions swallowed, too broad, or wrapped without the cause? Is `InterruptedException` handled?
- Is every `AutoCloseable` the code owns closed on all paths, and none closed that it does not own?
- Does shared mutable state lack one consistent thread-safety strategy (confinement, immutability, atomics/volatile, concurrent collection, or the same lock)? Are threads or executors left running?
- Are internal mutable collections exposed, or immutable ones modified?
- Do tests cover the new behaviour, with the project's JUnit version, and without sleeps or order dependence?
- Leave framework and database checks to their own skills.
