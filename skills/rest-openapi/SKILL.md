---
name: rest-openapi
description: Keep REST contracts and code in sync. Use when routes, clients or OpenAPI files change; not for internal-only changes or a bare mention of HTTP.
metadata:
  budget-planner-chars: "160"
  budget-coder-tokens: "1500"
  budget-reviewer-tokens: "600"
---

# REST and OpenAPI

## When this applies

- An OpenAPI or Swagger document, a route or controller, or an API client in this repository changes, or the task asks to change a REST contract.
- It does not apply to an internal change that leaves every request and response as it is, or to code that only mentions HTTP (a download, a log line). Then ignore this skill.

## Keep contract and implementation in sync

- Keep contract and implementation in sync. A change to a path, method, parameter, body, status code, header or error goes, in the same change, into: the OpenAPI document, the server code, the validation, the clients in this repository, and the tests. Change every one of these that the repository holds; do not create the ones it does not.
- Contract-only, server-only or client-only change: if the repository holds only that part, change only that part. Do not invent a server, a client or a contract. Say in your summary which other part has to follow. If another part is in the repository, it changes too.
- Do not edit a generated file by hand. Change the source or the annotations and regenerate. Commit what the repository commits.
- Do not add a dependency or a generator the repository does not use.

## Resources, methods and status codes

- Follow the existing naming: plural nouns for resources, the case style already used, no verbs in paths unless the API already does so.
- GET is safe: it changes nothing. PUT and DELETE are idempotent. POST and PATCH are not, unless the API says so.
- Choose the status code from the outcome and the existing contract (for example 201 for a created resource, 202 for accepted work, 204 for no body). Use the codes the API already uses for the same case. Do not mix codes for one situation.

## Validation

- Validate path, query, header and body at the boundary, as the contract says: types, formats, ranges, required fields, enums. Set limits for body size and text length.
- Reject what the contract does not allow with a client error. Never trust the client to have checked.

## Errors

- One error envelope for the whole API: reuse the one that exists. Document it once and reference it.
- Every failure that can happen on an operation is documented in the contract, returned by the code, in the envelope, and tested. Typical: 400 or 422 invalid input, 401 not authenticated, 403 not allowed, 404 not found, 409 conflict, 413 body too large, 415 media type, 429 rate limit, 5xx server failure. Document the ones that apply.
- Never return 200 with an error body. Never answer 500 for a client mistake.
- No stack traces, SQL, internal host names or secrets in an error.

## Pagination

- A list that can grow is paged, with a default and a maximum size. Use the paging the API already has (cursor, or page and size).
- Paging an existing unpaged list is a breaking change unless the default keeps the old result.

## Idempotency

- Idempotent means the same intended effect when repeated, not always the same response: a second DELETE may answer 404. GET, PUT and DELETE must be idempotent.
- A retried request must be safe. A POST that creates or charges needs the API's idempotency key if it has one; do not invent a new header for one endpoint. A repeated key with a different payload is rejected (409 or 422). Two concurrent requests with one key give one effect.

## Compatibility and versioning

- Stay backwards compatible by default. Usually safe: a new endpoint, a new optional request field or parameter. A new response field or enum value can still break strict validators or generated clients: check the published schema (`additionalProperties`, closed enums) and the clients you support.
- Breaking: removing or renaming a field, path or parameter; changing a type, format or meaning; a new required request field; making an optional field required; accepting fewer values; a changed status code, error envelope, default, paging or authentication.
- A breaking change needs the task to ask for it, and a new version or a deprecation in the repository's existing style (path, header or media type). Never break a published contract in place; if the task forces it and names no way, say so plainly in your summary.
- Mark what is deprecated with `deprecated: true` and keep it working.

## Security boundaries

- Every operation has its authentication in the contract (its own `security` or the inherited top-level one) and enforces it in code. A new endpoint is not public by default. A public operation (login, health, webhook) is explicit (`security: []`) and intended.
- Check access to the object itself, not only to the route: an id from the path must belong to the caller.
- Treat every input as untrusted. Do not return fields the caller may not see.
- No secrets or tokens in URLs, examples, logs or errors. Do not loosen CORS, rate limits or authentication to make a test pass.

## Tests

- Test what the contract promises: the success response, and each documented failure response.
- Test paging limits, and a repeated write (also two at once) where they exist.
- Use the repository's test style; update its contract or schema tests when it has them. For a client, test an error response too.

## Focused notes

- OpenAPI 3.x: reuse `components` with `$ref`. Keep each `operationId` stable: renaming it breaks generated clients. Keep `required`, nullability and `additionalProperties` as the code behaves.
- Swagger 2.0: stay in 2.0; do not convert unless asked.
- A document generated from code annotations: change the annotations, then check the generated document changed as intended.
