# Mail-bean

The current project is basically a script that reads bank debit notifications and imports them into Actual Budget

## Considerations

There are three separate adapters that are independent from each other

1. Gmail adapter
2. Parser adapter
3. Actual adapter

- The parser should fully testable via fixtures -> goldens tests
- Actual has an integration test that uses the docker image for actual shipped with the project for testing

- Do not write tests that the user did not ask for.

## Future development

Right now we are keeping things simple and having a single file for each adapter. 

- If sources other than gmail are required, we might create an adatpers/email/ module
- Parser adapter most likely does not need that treatment

Overall, try to keep things simple. We are not trying to bloat this project with unnecessary files/abstractions and tests.
