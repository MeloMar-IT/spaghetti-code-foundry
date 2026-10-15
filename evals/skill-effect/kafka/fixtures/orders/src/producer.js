// Publishes orders to Kafka. `kafka` is a kafkajs client made by the caller; this file does not import kafkajs.
export const ORDERS_TOPIC = "orders";

export function createOrderProducer(kafka) {
  return kafka.producer();
}

export async function publishOrder(producer, order) {
  await producer.send({ topic: ORDERS_TOPIC, messages: [{ value: JSON.stringify(order) }] });
}
