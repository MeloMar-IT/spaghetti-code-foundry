package com.example.orders;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import java.time.Instant;

@Entity
public class Order {
  public enum Status { OPEN, PAID, CANCELLED }

  @Id
  private Long id;
  private String customerId;
  private Status status;
  private int quantity;
  private long totalCents;
  private Instant createdAt;

  protected Order() {}

  public Order(String customerId, int quantity, long totalCents, Instant createdAt) {
    this.customerId = customerId;
    this.status = Status.OPEN;
    this.quantity = quantity;
    this.totalCents = totalCents;
    this.createdAt = createdAt;
  }

  public Long getId() { return id; }
  public String getCustomerId() { return customerId; }
  public Status getStatus() { return status; }
  public int getQuantity() { return quantity; }
  public long getTotalCents() { return totalCents; }
  public Instant getCreatedAt() { return createdAt; }

  public void setStatus(Status status) { this.status = status; }
}
