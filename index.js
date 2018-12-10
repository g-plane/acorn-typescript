const acorn = require('acorn')
const tt = acorn.tokTypes

const tsTypeKeyword = {
  any: 'TSAnyKeyword',
  boolean: 'TSBooleanKeyword',
  never: 'TSNeverKeyword',
  null: 'TSNullKeyword',
  number: 'TSNumberKeyword',
  object: 'TSObjectKeyword',
  string: 'TSStringKeyword',
  symbol: 'TSSymbolKeyword',
  undefined: 'TSUndefinedKeyword',
  unknown: 'TSUnknownKeyword',
  void: 'TSVoidKeyword'
}

const tsDeclaration = {
  interface: 1,
  type: 2,
  enum: 4,
  declare: 8
}

const tsTypeOperator = {
  typeof: 1,
  keyof: 2,
  infer: 4
}

module.exports = Parser => class TSParser extends Parser {
  computeLocByOffset(offset) {
    // If `locations` option is off, do nothing for saving performance.
    if (this.options.locations) {
      return acorn.getLineInfo(this.input, offset)
    }
  }

  startNodeAtNode(node) {
    return this.startNodeAt(node.start, this.computeLocByOffset(node.start))
  }

  // Studied from Babel
  parseExpressionStatement(node, expr) {
    return expr.type === 'Identifier'
      ? this._parseTSDeclaration(node, expr)
      : super.parseExpressionStatement(node, expr)
  }

  parseBindingAtom() {
    const node = super.parseBindingAtom()
    if (this.eat(tt.colon)) {
      node.typeAnnotation = this.parseTSTypeAnnotation()
      node.end = node.typeAnnotation.end
      if (this.options.locations) {
        node.loc.end = node.typeAnnotation.loc.end
      }
    }
    return node
  }

  parseFunctionBody(node, isArrowFunction) {
    // I know, return type doesn't belong to function body,
    // but this will be less hacky.
    if (this.eat(tt.colon)) {
      node.returnType = this.parseTSTypeAnnotation()
    }
    super.parseFunctionBody(node, isArrowFunction)
  }

  parseExpression() {
    const parenthesized = this.type === tt.parenL,
      parenStart = parenthesized ? this.start : -1
    let expr = super.parseExpression()

    if (parenthesized) {
      expr.extra = { parenthesized, parenStart }
      return expr
    }

    while (this.type === tt.name && this.value === 'as') {
      const node = this.startNodeAtNode(expr)
      this.next()
      node.expression = expr
      this._parseTSTypeAnnotation(node)
      expr = this.finishNode(node, 'TSAsExpression')
    }
    return expr
  }

  parseParenItem(item) {
    item = super.parseParenItem(item)
    while (this.type === tt.name && this.value === 'as') {
      const node = this.startNodeAtNode(item)
      this.next()
      node.expression = item
      this._parseTSTypeAnnotation(node)
      item = this.finishNode(node, 'TSAsExpression')
    }
    return item
  }

  parseTSTypeAnnotation() {
    const node = this.startNodeAt(this.lastTokStart, this.lastTokStartLoc)
    this._parseTSTypeAnnotation(node)
    return this.finishNode(node, 'TSTypeAnnotation')
  }

  _parseTSType() {
    let node = this._parseNonTSConditionalType()
    if (this.type === tt._extends) {
      node = this.parseTSConditionalType(node)
    }
    return node
  }

  _parseTSTypeAnnotation(node) {
    node.typeAnnotation = this._parseTSType()
  }

  _parseSimpleType() {
    let node
    switch (this.type) {
      case tt.name:
        node = this.value in tsTypeKeyword
          ? this.parseTSTypeKeyword()
          : this.parseTSTypeReference()
        break
      case tt.braceL:
        node = this.parseTSTypeLiteral()
        break
      case tt._void:
      case tt._null:
        node = this.parseTSTypeKeyword()
        break
      case tt.parenL:
        node = this.parseTSParenthesizedType()
        break
      case tt.bracketL:
        node = this.parseTSTupleType()
        break
      case tt.num:
      case tt.string:
      case tt._true:
      case tt._false:
        node = this.parseTSLiteralType(this.type)
        break
      case tt._import:
        node = this.parseTSImportType(false)
        break
      default:
        return
    }

    if (this.type === tt.bracketL) {
      node = this._parseMaybeTSArrayType(node)
    }

    return node
  }

  _parseNonTSConditionalType() {
    let node
    switch (this.type) {
      case tt._new:
        node = this.parseTSConstructorType()
        break
      case tt.name:
        switch (tsTypeOperator[this.value]) {
          case tsTypeOperator.infer:
            node = this.parseTSInferType()
            break
          default:
            node = this._parseSimpleType()
        }
        break
      default:
        node = this._parseSimpleType()
        break
    }
    if (
      this.type === tt.relational && this.value.charCodeAt(0) === 60 /* < */
    ) {
      const typeParameters = this.parseTSTypeParameterInstantiation()
      node.typeParameters = typeParameters
      node.end = typeParameters.end
      if (this.options.locations) {
        node.loc.end = typeParameters.loc.end
      }
    }
    if (this.type === tt.bitwiseAND) {
      node = this.parseTSIntersectionType(node)
    }
    if (this.type === tt.bitwiseOR) {
      node = this.parseTSUnionType(node)
    }
    return node || this.unexpected()
  }

  _parseTSDeclaration(node, expr) {
    const val = tsDeclaration[expr.name]
    switch (val) {
      case tsDeclaration.interface:
        if (this.type === tt.name) {
          return this.parseTSInterfaceDeclaration()
        }
        break
      case tsDeclaration.type:
        if (this.type === tt.name) {
          return this.parseTSTypeAliasDeclaration()
        }
        break
      default:
        break
    }
    return super.parseExpressionStatement(node, expr)
  }

  parseTSTypeReference() {
    const node = this.startNode()
    let typeName = this.parseIdent()
    if (this.type === tt.dot) {
      typeName = this.parseTSQualifiedName(typeName)
    }
    node.typeName = typeName
    if (
      this.type === tt.relational && this.value.charCodeAt(0) === 60 /* < */
    ) {
      node.typeParameters = this.parseTSTypeParameterInstantiation()
    }
    this.finishNode(node, 'TSTypeReference')
    return node
  }

  parseTSTypeKeyword() {
    const node = this.startNode()
    const keyword = this.value
    this.next()
    this.finishNode(node, tsTypeKeyword[keyword])
    return node
  }

  parseTSLiteralType(tokType) {
    const node = this.startNode()
    const literal = this.parseLiteral(this.value)
    if (tokType === tt._true || tokType === tt._false) {
      literal.value = tokType === tt._true
    }
    node.literal = literal
    return this.finishNode(node, 'TSLiteralType')
  }

  parseTSTupleType() {
    const node = this.startNode()
    const elementTypes = []
    this.eat(tt.bracketL)
    let first = true
    while (!this.eat(tt.bracketR)) {
      first ? (first = false) : this.expect(tt.comma)
      switch (this.type) {
        case tt.name:
          const elem = this.parseTSTypeReference()
          if (this.type === tt.question) {
            elementTypes.push(this.parseTSOptionalType(elem))
          } else {
            elementTypes.push(elem)
          }
          break
        case tt.ellipsis:
          elementTypes.push(this.parseTSRestType())
          break
        case tt.bracketR:
          break
        default:
          this.unexpected()
      }
    }
    node.elementTypes = elementTypes
    return this.finishNode(node, 'TSTupleType')
  }

  parseTSOptionalType(typeRef) {
    const node = this.startNodeAt(this.lastTokStart, this.lastTokStartLoc)
    this.expect(tt.question)
    node.typeAnnotation = typeRef
    return this.finishNode(node, 'TSOptionalType')
  }

  parseTSRestType() {
    const node = this.startNode()
    this.expect(tt.ellipsis)
    this._parseTSTypeAnnotation(node)
    return this.finishNode(node, 'TSRestType')
  }

  _parseMaybeTSArrayType(prev) {
    const node = this.startNodeAtNode(prev)
    this.expect(tt.bracketL)
    if (this.eat(tt.bracketR)) {
      return this.parseTSArrayType(node, prev)
    }
    return this.parseTSIndexedAccessType(node, prev)
  }

  parseTSArrayType(node, elementType) {
    node.elementType = elementType
    return this.finishNode(node, 'TSArrayType')
  }

  parseTSIndexedAccessType(node, objectType) {
    node.objectType = objectType
    node.indexType = this._parseTSType()
    this.expect(tt.bracketR)
    return this.finishNode(node, 'TSIndexedAccessType')
  }

  parseTSParenthesizedType() {
    const node = this.startNode()
    this.expect(tt.parenL)
    this._parseTSTypeAnnotation(node)
    this.expect(tt.parenR)
    return this.finishNode(node, 'TSParenthesizedType')
  }

  parseTSUnionType(first) {
    const node = first
      ? this.startNodeAtNode(first)
      : this.startNode()
    const types = []
    first && types.push(first)
    while (this.eat(tt.bitwiseOR)) {
      types.push(this._parseTSIntersectionTypeOrHigher())
    }
    node.types = types
    return this.finishNode(node, 'TSUnionType')
  }

  parseTSIntersectionType(first) {
    const node = first
      ? this.startNodeAtNode(first)
      : this.startNode()
    const types = []
    first && types.push(first)
    while (this.eat(tt.bitwiseAND)) {
      types.push(this._parseSimpleType())
    }
    node.types = types
    return this.finishNode(node, 'TSIntersectionType')
  }

  _parseTSIntersectionTypeOrHigher() {
    const node = this._parseSimpleType()
    if (this.type === tt.bitwiseAND) {
      return this.parseTSIntersectionType(node)
    }
    return node
  }

  _parseTSUnionTypeOrHigher() {
    const node = this._parseTSIntersectionTypeOrHigher()
    if (this.type === tt.bitwiseOR) {
      return this.parseTSUnionType(node)
    }
    return node
  }

  parseTSConditionalType(checkType) {
    const node = this.startNodeAtNode(checkType)
    node.checkType = checkType
    this.expect(tt._extends)
    node.extendsType = this._parseNonTSConditionalType()
    this.expect(tt.question)
    node.trueType = this._parseNonTSConditionalType()
    this.expect(tt.colon)
    node.falseType = this._parseNonTSConditionalType()
    return this.finishNode(node, 'TSConditionalType')
  }

  parseTSInferType() {
    const node = this.startNode()
    this.next()
    node.typeParameter = this.parseTSTypeParameter()
    return this.finishNode(node, 'TSInferType')
  }

  parseTSImportType(isTypeOf) {
    const node = this.startNode()
    node.isTypeOf = isTypeOf
    this.expect(tt._import)
    this.expect(tt.parenL)
    node.parameter = this.parseTSLiteralType(this.type)
    this.expect(tt.parenR)
    if (this.eat(tt.dot)) {
      let qualifier = this.parseIdent()
      if (this.type === tt.dot) {
        qualifier = this.parseTSQualifiedName(qualifier)
      }
      node.qualifier = qualifier
    }
    return this.finishNode(node, 'TSImportType')
  }

  parseTSQualifiedName(left) {
    let node = this.startNodeAtNode(left)
    node.left = left
    this.expect(tt.dot)
    node.right = this.parseIdent()
    node = this.finishNode(node, 'TSQualifiedName')
    if (this.type === tt.dot) {
      node = this.parseTSQualifiedName(node)
    }
    return node
  }

  parseTSConstructorType() {
    const node = this.startNode()
    this.expect(tt._new)
    node.typeParameters = this.parseMaybeTSTypeParameterDeclaration()
    this.expect(tt.parenL)
    node.parameters = this.parseBindingList(
      tt.parenR,
      false,
      this.options.ecmaVersion >= 8
    )
    this.expect(tt.arrow)
    node.typeAnnotation = this.parseTSTypeAnnotation()
    return this.finishNode(node, 'TSConstructorType')
  }

  parseTSConstructSignatureDeclaration() {
    const node = this.startNode()
    this.expect(tt._new)
    node.typeParameters = this.parseMaybeTSTypeParameterDeclaration()
    this.expect(tt.parenL)
    node.parameters = this.parseBindingList(
      tt.parenR,
      false,
      this.options.ecmaVersion >= 8
    )
    if (this.eat(tt.colon)) {
      node.typeAnnotation = this.parseTSTypeAnnotation()
    }
    return this.finishNode(node, 'TSConstructSignatureDeclaration')
  }

  parseTSTypeLiteral() {
    return this._parseObjectLikeType('TSTypeLiteral', 'members')
  }

  parseTSTypeAliasDeclaration() {
    const node = this.startNodeAt(this.lastTokStart, this.lastTokStartLoc)
    node.id = this.parseIdent()
    node.typeParameters = this.parseMaybeTSTypeParameterDeclaration()
    this.expect(tt.eq)
    this._parseTSTypeAnnotation(node)
    this.semicolon()
    return this.finishNode(node, 'TSTypeAliasDeclaration')
  }

  parseTSInterfaceDeclaration() {
    const node = this.startNodeAt(this.lastTokStart, this.lastTokStartLoc)
    node.id = this.parseIdent()
    node.typeParameters = this.parseMaybeTSTypeParameterDeclaration()
    if (this.eat(tt._extends)) {
      const heritage = []
      do {
        heritage.push(this.parseTSExpressionWithTypeArguments())
      } while (this.eat(tt.comma))
      node.heritage = heritage
    }
    node.body = this._parseObjectLikeType('TSInterfaceBody', 'body')
    this.semicolon()
    return this.finishNode(node, 'TSInterfaceDeclaration')
  }

  parseTSExpressionWithTypeArguments() {
    const node = this.startNode()
    let expr = this.parseIdent()
    if (this.eat(tt.dot)) {
      expr = this.parseTSQualifiedName(expr)
    }
    node.expr = expr
    if (
      this.type === tt.relational && this.value.charCodeAt(0) === 60 /* < */
    ) {
      const typeParameters = this.parseTSTypeParameterInstantiation()
      node.typeParameters = typeParameters
      node.end = typeParameters.end
      if (this.options.locations) {
        node.loc.end = typeParameters.loc.end
      }
    }
    return this.finishNode(node, 'TSExpressionWithTypeArguments')
  }

  parseTSTypeParameter() {
    const node = this.startNode()
    if (this.type === tt.name) {
      node.name = this.value
      this.next()
    } else {
      this.unexpected()
    }
    if (this.eat(tt._extends)) {
      node.constraint = this._parseTSType()
    }
    if (this.eat(tt.eq)) {
      node.default = this._parseTSType()
    }
    return this.finishNode(node, 'TSTypeParameter')
  }

  parseMaybeTSTypeParameterDeclaration() {
    if (
      this.type === tt.relational && this.value.charCodeAt(0) === 60 /* < */
    ) {
      const node = this.startNode()
      const params = []
      let first = true
      this.next()
      while (!this.eat(tt.relational)) {
        first ? (first = false) : this.expect(tt.comma)
        if (
          this.type === tt.relational && this.value.charCodeAt(0) === 62 /* > */
        ) {
          break
        }
        params.push(this.parseTSTypeParameter())
      }
      node.params = params
      return this.finishNode(node, 'TSTypeParameterDeclaration')
    }
  }

  parseTSTypeParameterInstantiation() {
    const node = this.startNode()
    const params = []
    this.next()
    let first = true
    while (!this.eat(tt.relational)) {
      first ? (first = false) : this.expect(tt.comma)
      if (
        this.type === tt.relational && this.value.charCodeAt(0) === 62 /* > */
      ) {
        break
      }
      params.push(this._parseTSType())
    }
    node.params = params
    return this.finishNode(node, 'TSTypeParameterInstantiation')
  }

  _parseObjectLikeType(kind, prop) {
    const node = this.startNode()
    this.expect(tt.braceL)
    const list = []
    while (!this.eat(tt.braceR)) {
      switch (this.type) {
        case tt.name:
          const key = this.parseIdent()
          switch (this.type) {
            case tt.parenL:
            case tt.relational:
              list.push(this.parseTSMethodSignature(key))
              break
            case tt.colon:
            case tt.semi:
            case tt.comma:
            case tt.braceR:
              list.push(this.parseTSPropertySignature(key))
              break
            default:
              if (
                acorn.lineBreak.test(
                  this.input.slice(this.lastTokEnd, this.start)
                )
              ) {
                list.push(this.parseTSPropertySignature(key))
                continue
              }
              this.unexpected()
          }
          break
        case tt._new:
          list.push(this.parseTSConstructSignatureDeclaration())
          break
        default:
          this.unexpected()
      }
    }
    node[prop] = list
    return this.finishNode(node, kind)
  }

  parseTSMethodSignature(key) {
    const node = this.startNodeAtNode(key)
    node.key = key
    node.typeParameters = this.parseMaybeTSTypeParameterDeclaration()
    this.expect(tt.parenL)
    node.parameters = this.parseBindingList(
      tt.parenR,
      false,
      this.options.ecmaVersion >= 8
    )
    if (this.eat(tt.colon)) {
      this._parseTSTypeAnnotation(node)
    }
    this.eat(tt.comma) || this.eat(tt.semi)
    return this.finishNode(node, 'TSMethodSignature')
  }

  parseTSPropertySignature(key) {
    const node = this.startNodeAtNode(key)
    node.key = key
    if (this.eat(tt.colon)) {
      this._parseTSTypeAnnotation(node)
    }
    this.eat(tt.comma) || this.eat(tt.semi)
    return this.finishNode(node, 'TSPropertySignature')
  }
}
