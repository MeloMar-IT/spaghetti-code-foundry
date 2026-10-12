---
name: ibm-mq
description: "IBM MQ queues and topics done safely. Use when code or config uses an IBM MQ client (MQI, IBM MQ JMS, MQSC); not for Kafka, AMQP or a bare mention of MQ."
metadata:
  budget-planner-chars: "160"
  budget-coder-tokens: "2300"
  budget-reviewer-tokens: "650"
---

# IBM MQ

## When this applies

- The change touches code or configuration that uses an IBM MQ client: `com.ibm.mq` or `com.ibm.msg.client` (Java, JMS), `ibmmq` (Node.js), `pymqi` (Python), `mq-golang` (Go), MQI calls in C or COBOL, MQSC scripts, a CCDT or `mqclient.ini`.
- It does not apply to Kafka, RabbitMQ, ActiveMQ, AMQP, JMS on another broker, or a task that only says "MQ" or "queue". Then ignore this skill. Offsets, consumer groups, exchanges and broker acks are not IBM MQ concepts: do not carry them over, in either direction.
- Test set-up belongs to the integration-testing skill, language rules to the language skill.

## Follow the repository first

- Use the client library, wrapper, connection factory and configuration keys the repository has. Do not add a second client or a dependency.
- Queue manager, channel, queue and topic names come from configuration, never from a literal in the code.
- Do not define or alter queue-manager objects (MQSC) unless the task asks. Say in your summary what an administrator must define.

## Credentials and connections

- This skill grants no access to any queue manager. Do not connect to a shared or production queue manager, and do not ask for, guess or invent credentials.
- User, password and key store come from the secret mechanism the repository already uses. Never put them in code, MQSC, a CCDT, tests, logs or error text.
- Do not weaken security to make a connection work: no blank or privileged `MCAUSER`, no disabled `CHLAUTH` or `CONNAUTH`, no dropped TLS cipher.

## Transaction and acknowledgement boundaries

- For every get and put, state in the code whether it is inside a unit of work. MQI: always pass `MQGMO_SYNCPOINT` / `MQPMO_SYNCPOINT` or the `NO_SYNCPOINT` form; the default differs per platform (syncpoint on z/OS, none elsewhere). JMS: choose the session mode on purpose: transacted, `CLIENT_ACKNOWLEDGE` or `AUTO_ACKNOWLEDGE`.
- A get outside syncpoint removes the message at once: a crash during processing loses it. A message that must not be lost is got under syncpoint (or a transacted session).
- Consume, process, produce: get under syncpoint, do the work, put the output in the same unit of work, commit once at the end. On any failure back out; never commit in a `finally`.
- `MQDISC` and a JMS `close` do not replace the decision: a normal `MQDISC` commits a pending unit of work. Back out explicitly on every error path before disconnecting.
- JMS: `acknowledge()` in `CLIENT_ACKNOWLEDGE` acknowledges every message the session has consumed so far, not one. With `AUTO_ACKNOWLEDGE` the message is acknowledged when `onMessage` or `receive` returns. A session and its transaction belong to one thread.
- Messages put under syncpoint are invisible until the commit. Commit the request before you wait for its reply.
- MQ plus a database is two commits unless the repository already has an XA coordinator. Without XA: commit the database first, then MQ, and make the handler idempotent. Do not claim exactly-once.
- Keep a unit of work short and bounded: commit a batch after a fixed count, never hold one open across a long wait.

## Messages: MQMD, identifiers, correlation

- Message and correlation ids are 24 bytes, not text. Compare bytes; never pass them through a character set. JMS shows them as `ID:` plus hex.
- Let the queue manager create the message id (`MQMI_NONE` or `MQPMO_NEW_MSG_ID`). A reused MQMD otherwise repeats the last id.
- `MsgId` and `CorrelId` are input and output of a get. Reset them before each get, or a stale value matches nothing.
- Request/reply: the requester sets `MQMT_REQUEST`, `ReplyToQ` and an expiry, and gets the reply by correlation id (`MQMO_MATCH_CORREL_ID`, or a `JMSCorrelationID` selector) with a bounded wait. The responder replies to the queue named in the request and, unless the report options say otherwise, copies the request `MsgId` into the reply `CorrelId`. Use the correlation pattern the other side already uses.
- Never take "the next message" from a shared reply queue. Handle a reply that comes after the requester gave up: give it an expiry, and keep the requester safe.
- A temporary dynamic reply queue goes away with its connection and cannot hold persistent messages.
- Set persistence on purpose (`MQPER_PERSISTENT`, not persistent, or as the queue default). A non-persistent message can be lost at a restart. A persistent message belongs in a unit of work.
- MQMD `Expiry` is in tenths of a second; JMS time-to-live is in milliseconds.

## Encoding

- Text: `MQFMT_STRING` with the right `CodedCharSetId`, read with `MQGMO_CONVERT`. Binary: `MQFMT_NONE`, never converted. A wrong format or CCSID corrupts data on an EBCDIC partner.
- JMS to a non-JMS receiver: the destination's target client must be MQ (`targetClient=1`), or the receiver gets an `MQRFH2` header before the payload. Do not change it on an existing destination without checking every consumer.
- Never accept a truncated business message (`MQGMO_ACCEPT_TRUNCATED_MSG`). On reason 2080 enlarge the buffer and get again.

## Poison messages and backout

- A backed-out message returns to the queue with a higher `BackoutCount` (`JMSXDeliveryCount` is one more). Without a limit it is redelivered forever and blocks the queue.
- Compare the count with the queue's `BOTHRESH`. At the threshold, put the message unchanged on the queue's `BOQNAME` in the same unit of work as the get, then commit. IBM MQ classes for JMS do this themselves when `BOTHRESH` is above 0 (to `BOQNAME`, else the dead-letter queue); MQI, Node.js, Python and Go code must do it.
- If `BOTHRESH` is 0 or there is no backout queue, say so in your summary. Never commit to get rid of a bad message, and never discard one.
- Tell permanent from transient. An unreadable or invalid message goes to the backout queue. A dependency that is down means back out, pause with backoff and try again; do not drain the queue into the backout queue.
- The count is exact only with `HARDENBO`; treat it as a lower bound.

## Duplicates and retries

- Delivery is at least once whenever the work and the commit are not one transaction. Make the handler idempotent: store a business key or the message id with the effect, in the same database transaction.
- A put or commit that fails with a broken connection (2009) has an unknown outcome. Resend only when a duplicate is harmless or detected.
- Retry with a limit and a growing delay. Retry connection reasons (2009, 2059, 2161, 2162, 2538). Do not retry 2035 (not authorised) or 2085 (unknown object). 2053 (queue full) needs back-pressure. 2033 (no message) is the normal end of a wait.
- Log completion and reason code (JMS: the linked exception), never the payload or a password.

## Reconnect

- Use the automatic client reconnect the repository configures (`MQCNO_RECONNECT`, JMS `WMQ_CLIENT_RECONNECT`); do not add a second mechanism. IBM MQ classes for Java (not JMS) and XA connections have none.
- A reconnect backs out the unit of work in flight: the commit fails with 2003. Redo the whole unit from the get; never continue it or resend only the put.
- Use `RECONNECT_Q_MGR` (same queue manager) when the code depends on state held there: a reply queue, message order, a subscription.
- Manual reconnect: close and rebuild connection, session and consumers; never reuse a handle. One attempt at a time, with a capped, growing delay.
- Get with a bounded wait and `MQGMO_FAIL_IF_QUIESCING`, never a sleep-and-poll loop. On shutdown: stop consuming, finish or back out, close, disconnect.
- A second consumer or a backout breaks message order. If order matters, keep one consumer, or use message groups.

## Publish/subscribe

- Publish to the configured topic string. The wildcards `#` and `+` belong in subscriptions only.
- Choose durable or non-durable on purpose. A durable subscription has a fixed name from configuration (`MQSO_CREATE` with `MQSO_RESUME`), keeps messages while the application is down, and must be removed when its subscriber is retired. A non-durable one loses what is published while it is disconnected.
- Several instances of one service must share one subscription (a shared subscription or one destination queue), or each instance processes every publication.
- A new subscriber may get a retained publication: tolerate an old message. Do not publish retained unless asked.
- Syncpoint, backout, duplicates and reconnect rules are the same as for queues.

## Tests

- Cover: put and get with commit and with backout (the message is back, the count is higher); request/reply with a matching reply, a timeout and a late reply; a poison message that reaches the backout queue at the threshold; a duplicate delivery with one effect; a connection lost inside a unit of work.
- Use the queue manager or fake the repository already starts, with unique queue names. If none is available, test the logic behind the wrapper and say what is not covered.
