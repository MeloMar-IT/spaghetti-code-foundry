package org.example.tree;

/** A small binary search tree of int values. */
public final class Tree {
    private static final class Node {
        final int value;
        Node left;
        Node right;

        Node(int value) {
            this.value = value;
        }
    }

    private Node root;
    private int size;

    /** Adds a value. A value that is already in the tree is ignored. */
    public void insert(int value) {
        if (root == null) {
            root = new Node(value);
            size = 1;
            return;
        }
        Node n = root;
        while (true) {
            if (value == n.value) {
                return;
            }
            if (value < n.value) {
                if (n.left == null) {
                    n.left = new Node(value);
                    size++;
                    return;
                }
                n = n.left;
            } else {
                if (n.right == null) {
                    n.right = new Node(value);
                    size++;
                    return;
                }
                n = n.right;
            }
        }
    }

    /** Returns true when the value is in the tree. */
    public boolean contains(int value) {
        Node n = root;
        while (n != null) {
            if (value == n.value) {
                return true;
            }
            n = value < n.value ? n.left : n.right;
        }
        return false;
    }

    /** Returns the number of values in the tree. */
    public int size() {
        return size;
    }

    /** Returns the values in ascending order. */
    public int[] inOrder() {
        int[] out = new int[size];
        fill(root, out, 0);
        return out;
    }

    private static int fill(Node n, int[] out, int at) {
        if (n == null) {
            return at;
        }
        int next = fill(n.left, out, at);
        out[next++] = n.value;
        return fill(n.right, out, next);
    }
}
