# REST and OpenAPI review checks

- Does the change alter a request or response (path, method, parameter, body, status code, header, error)? If so, do the OpenAPI document, server code, validation, clients in this repository and tests all change together and agree, for every part the repository holds? Only a repository that holds the contract alone may leave the rest out, and then the summary names what must follow.
- Is it backwards compatible? Flag a removed or renamed field, path or parameter, a changed type or meaning, a new required request field, fewer accepted values, a changed status code or default, a new response field or enum value that strict clients reject, unless the task asks for it and it is versioned or deprecated the repository's way.
- Failure responses: does each operation document, return, envelope and test every failure that applies (invalid input, not authenticated, not allowed, not found and conflict; 413, 415, 429 or a server failure where relevant)? Is there a 200 with an error body, or a 500 for a client mistake?
- Do errors leak stack traces, SQL, internal host names or secrets?
- Is input validated at the boundary as the contract says, with body and page size limits?
- Are growing lists paged with a maximum? Is a retried write safe, also for concurrent duplicates and a reused key with another payload?
- Does every new or changed operation declare (own or inherited `security`, or an intended public `security: []`) and enforce authentication, and check access to the object itself?
- Was a generated file edited by hand, or an `operationId` renamed?
- Are the failure responses tested, not only success?
- Leave language, framework and database checks to their own skills.
