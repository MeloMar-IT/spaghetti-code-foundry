package org.example.tree;

import java.util.Arrays;

public final class TreeCheck {
    public static void main(String[] args) {
        Tree empty = new Tree();
        check(empty.size() == 0, "an empty tree has size 0");
        check(!empty.contains(1), "an empty tree contains nothing");

        Tree tree = new Tree();
        tree.insert(5);
        tree.insert(3);
        tree.insert(8);
        tree.insert(3);
        check(tree.size() == 3, "a duplicate is ignored");
        check(tree.contains(8), "contains 8");
        check(!tree.contains(4), "does not contain 4");
        check(Arrays.equals(tree.inOrder(), new int[] {3, 5, 8}), "in order");
    }

    private static void check(boolean ok, String what) {
        if (!ok) {
            throw new AssertionError(what);
        }
    }
}
