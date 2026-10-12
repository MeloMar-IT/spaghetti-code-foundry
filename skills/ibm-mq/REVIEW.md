# IBM MQ review checks

- Boundaries: is every get and put explicitly inside or outside a unit of work (syncpoint option, JMS session mode)? Is a message that must not be lost got under syncpoint, with the output put in the same unit of work and one commit after the work? Is there a commit in a `finally`, or a disconnect that commits a failed unit?
- Duplicates: can a redelivery, a retry after a broken connection (2009) or a second instance apply the effect twice? Is the handler idempotent, and is the key stored with the effect? Does anything claim exactly-once without XA?
- Poison messages: what happens to a message that always fails? Is it moved unchanged to the backout queue in the same unit of work as the get? Is a bad message committed away, discarded or logged with its payload?
- Backout thresholds: is `BackoutCount` (or `JMSXDeliveryCount`) checked against the queue's `BOTHRESH`, not a made-up number? Is a `BOTHRESH` of 0 or a missing `BOQNAME` reported? Does a transient failure drain the queue into the backout queue?
- Reconnect safety: after a reconnect or reason 2003, is the whole unit of work redone from the get? Are handles rebuilt and never reused? Is the retry bounded with a growing delay, and are 2035 and 2085 not retried? Is every wait bounded?
- Correlation: is the reply got by correlation id with a timeout, are `MsgId` and `CorrelId` reset before each get, are ids handled as bytes, and is a late reply handled?
- Persistence, expiry, format and CCSID: set on purpose, and still right for a non-JMS or EBCDIC partner?
- Pub/sub: durable or not on purpose, a fixed subscription name, one shared subscription for several instances?
- Are credentials, host names or channel secrets in code, MQSC, tests or logs? Is channel security weakened? Does a test use a shared queue manager?
- Are Kafka or AMQP ideas (offsets, consumer groups, exchanges) used for IBM MQ? Leave those brokers to their own skills.
