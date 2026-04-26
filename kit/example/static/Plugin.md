# Plugin

A plugin is the basic functional unit in Harbors. Each feature requires implementing one or even multiple plugins that work together.

To understand plugins, you need to know the following parts:

- main
- panel
- contribute / message

## main

The main part is mainly responsible for caching some in-memory data.

- After a plugin starts, main will always exist
- When plugins (including itself) start and stop, corresponding hooks will be triggered, allowing plugins to provide data to each other for extensibility (Contribute mechanism)

## panel

The panel part is responsible for displaying data on the window and providing interaction.

- After a plugin starts, panel may not necessarily exist; panel needs to be mounted into a window
- Every time a panel starts, it should query main for current data for initialization

Plugins communicate with each other using **Message**.

## message / contribute

When developing a feature, you may often need to rely on an existing feature, which requires actively manipulating another feature. This is done through Message communication.

index.ts
```typescript
Editor.Message.request('example', 'test');
```

Another scenario is when we develop a feature, but we want other features to be able to register some new capabilities into our feature in the future.

For example, we developed a cool interface, and we want other plugins to be able to change the color, style, etc. of our interface. This is when Contribute comes in handy.

package.json
```json
{
    "name": "test",
    "contribute": {
        "message": {
            "method": []
        }
    }
}
```
