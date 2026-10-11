# Accessibility check scripts

Manual scripts for the nine critical journeys. They check what the automatic tests cannot: the keyboard in a real browser and a screen reader. The automatic tests are listed in [ACCESSIBILITY.md](ACCESSIBILITY.md). The gate is `tests/ui-a11y-journeys.test.ts`, which has a test for each journey here.

**Nothing in these scripts has been run.** No browser and no screen reader were used when they were written. The owner runs them and fills in the tables.

## How to use

- Run each journey twice: once with the keyboard only, once with a screen reader (VoiceOver on macOS, NVDA on Windows, Orca on Linux).
- Run each journey as an admin and as a user, except those marked **Admin only**.
- A step passes when its **Expect** result happens. Write what went wrong in the table when it does not.
- Report a failure as a GitHub issue with the label `accessibility` (the address is in [ACCESSIBILITY.md](ACCESSIBILITY.md)).

## 1. Sign in

### Keyboard

1. Open the address of the Foundry while signed out. **Expect:** the sign-in form is the first thing you reach with Tab.
2. Tab through the e-mail field, the password field and the button. **Expect:** each has a visible focus ring and a visible label.
3. Submit a wrong password with Enter. **Expect:** the error is shown and focus stays in the form.
4. Sign in with the right password. **Expect:** the home page opens.
5. Press Enter on **Account**, then Tab to **Accessibility**. **Expect:** the menu opens, the link is reachable and Enter opens the statement.

### Screen reader

1. Open the address. **Expect:** it reads the page title and the heading **Sign in**.
2. Move to each field. **Expect:** it reads the field's name and type.
3. Submit a wrong password. **Expect:** the error is read out.
4. Open the account menu. **Expect:** it reads the user and the **Accessibility** link.

### Results

| Date | Browser | Screen reader | Pass/fail |
|---|---|---|---|
|  |  |  |  |

## 2. Start work

### Keyboard

1. Open **Start work**. **Expect:** Tab reaches the flow choice, every field and the button, in reading order.
2. Leave a required field empty and press Enter. **Expect:** the form is not sent and the problem is shown next to the field.
3. Fill in the form and press Enter. **Expect:** the run starts and the run page opens.

### Screen reader

1. Open **Start work**. **Expect:** the heading is read, and each field is read with its name and help text.
2. Submit with a required field empty. **Expect:** the message is read out and the field is marked invalid.
3. Submit a good form. **Expect:** the run page is announced.

### Results

| Date | Browser | Screen reader | Pass/fail |
|---|---|---|---|
|  |  |  |  |

## 3. Follow a run and read its log

### Keyboard

1. Open **Runs** and Tab to a run. **Expect:** the link has a focus ring and Enter opens it.
2. On the run page, Tab to the **Log** tab and press Enter. **Expect:** the log opens and focus stays on the tab.
3. Wait for a new log line. **Expect:** focus and scroll position do not jump.

### Screen reader

1. Open **Runs**. **Expect:** each run is read with its flow and status.
2. Open a run. **Expect:** the heading and the status are read.
3. Open the **Log** tab. **Expect:** the tab is read as selected and the log can be read line by line.
4. Wait for a status change. **Expect:** it is announced politely, once.

### Results

| Date | Browser | Screen reader | Pass/fail |
|---|---|---|---|
|  |  |  |  |

## 4. Approve or reject

### Keyboard

1. Open a run that waits for you. **Expect:** **Approve** and **Reject** are reachable with Tab.
2. Press Enter on **Approve**. **Expect:** a dialog opens and focus moves into it.
3. Press Esc. **Expect:** the dialog closes and focus returns to the button.
4. Repeat for **Reject**, then confirm. **Expect:** the run goes on or stops, and the page says so.

### Screen reader

1. Open the run. **Expect:** it reads that the run waits for you and what is asked.
2. Open the **Approve** dialog. **Expect:** it reads the dialog's name and the first control.
3. Confirm. **Expect:** the result is announced.

### Results

| Date | Browser | Screen reader | Pass/fail |
|---|---|---|---|
|  |  |  |  |

## 5. Answer planner questions

### Keyboard

1. Open a run whose planner asked questions. **Expect:** the questions come before the answer field in Tab order.
2. Press Enter in the empty answer form. **Expect:** it is not sent and the problem is shown.
3. Type an answer and send it. **Expect:** the form is replaced by the new state of the run.

### Screen reader

1. Open the run. **Expect:** the questions are read as text and the answer field has a name.
2. Send an empty answer. **Expect:** "Write your answer first." is read out.
3. Send a real answer. **Expect:** the new state is announced.

### Results

| Date | Browser | Screen reader | Pass/fail |
|---|---|---|---|
|  |  |  |  |

## 6. Open a board card

**Admin only.** The user display has no Board page.

### Keyboard

1. Open **Board**. **Expect:** Tab reaches the filters, then each card in column order.
2. Press Enter on a card. **Expect:** its story opens and nothing moves unexpectedly.
3. Use a filter button, then Tab on. **Expect:** focus stays on the filter after the board redraws.

### Screen reader

1. Open **Board**. **Expect:** each column is read with its name and each card with its title and story number.
2. Move to a card. **Expect:** its status is read with it.
3. Change a filter. **Expect:** the change is read out.

### Results

| Date | Browser | Screen reader | Pass/fail |
|---|---|---|---|
|  |  |  |  |

## 7. Edit and save a flow

**Admin only.** The user display has no Flows page.

### Keyboard

1. Open **Flows**, then a flow. **Expect:** the form editor opens and Tab reaches every field and **Save**.
2. Press Enter on **Overview**. **Expect:** the graph is shown. The form editor and the YAML editor do the same work without the mouse.
3. Press Enter on **YAML**, break the text and press **Save**. **Expect:** the errors are shown and can be reached with Tab.
4. Fix the error and press **Save**. **Expect:** the flow is saved and the page says so.

### Screen reader

1. Open a flow. **Expect:** the heading and the editor tabs are read.
2. Open **Overview**. **Expect:** the graph is read as **Flow steps**, and the same steps are in the form editor.
3. Save with an error. **Expect:** the errors are read out.
4. Save a good flow. **Expect:** the success is announced.

### Results

| Date | Browser | Screen reader | Pass/fail |
|---|---|---|---|
|  |  |  |  |

## 8. Add a repository

### Keyboard

1. Open **Repositories** and press Enter on **Add repository**. **Expect:** a dialog opens and focus moves into it.
2. Press Enter with the form empty. **Expect:** it is not sent and the first invalid field is marked.
3. Fill in the form and send it. **Expect:** the dialog closes, focus returns to the button and the repository is in the list.
4. Open the dialog again and press Esc. **Expect:** it closes and focus returns.

### Screen reader

1. Open **Repositories**. **Expect:** the list is read with each address.
2. Open the dialog. **Expect:** it reads the dialog's name and each field with its label.
3. Send an empty form. **Expect:** the problem is read out and the field is marked invalid.
4. Send a good form. **Expect:** the new repository is announced.

### Results

| Date | Browser | Screen reader | Pass/fail |
|---|---|---|---|
|  |  |  |  |

## 9. Add a user

**Admin only.** The user display has no Users page.

### Keyboard

1. Open **Users** and press Enter on **+ Add user**. **Expect:** a dialog opens and focus moves into it.
2. Tab through the fields and the buttons. **Expect:** the order is the reading order and focus stays inside the dialog.
3. Send the form. **Expect:** the dialog closes, focus returns and the new user is in the list.

### Screen reader

1. Open **Users**. **Expect:** each user is read with the name and the role.
2. Open **Add user**. **Expect:** it reads the dialog's name and each field with its label.
3. Send the form. **Expect:** the result is read out.

### Results

| Date | Browser | Screen reader | Pass/fail |
|---|---|---|---|
|  |  |  |  |
