# acorn-typescript

This is an [Acorn](https://github.com/acornjs/acorn) plugin for parsing TypeScript code.

**It's still in progress. Don't use it in production.**

## Usage

```javascript
import acorn from 'acorn'
import acornTs from 'acorn-typescript'

const parser = acorn.Parser.extend(acornTs)
parser.parse('let a: number')
```

## License

MIT License (c) 2018-present Pig Fang
