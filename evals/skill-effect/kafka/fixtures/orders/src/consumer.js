// Consumes orders from Kafka. `kafka` and `consumer` are kafkajs objects made by the caller; this file does not import kafkajs.
// deps = { process(order): Promise, producer: { send(record): Promise }, sleep(ms): Promise }
export const ORDERS_TOPIC = "orders";

export function createOrderConsumer(kafka) {
  return kafka.consumer({ groupId: "orders-service" });
}

export async function handleMessage({ topic, partition, message }, deps) {
  const order = JSON.parse(message.value.toString());
  await deps.process(order);
}

export async function runOrderConsumer(consumer, deps) {
  await consumer.connect();
  await consumer.subscribe({ topics: [ORDERS_TOPIC] });
  await consumer.run({ eachMessage: (payload) => handleMessage(payload, deps) });
}
