'use strict'

/*
 * youch
 *
 * (c) Harminder Virk <virk@adonisjs.com>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

const fs = require('fs')
const path = require('path')
const cookie = require('cookie')
const Mustache = require('mustache')
const { fileURLToPath } = require('url')
const StackTracey = require('stacktracey')
const VIEW_PATH = './error.compiled.mustache'

const viewTemplate = fs.readFileSync(path.join(__dirname, VIEW_PATH), 'utf-8')

class Youch {
  constructor (error, request) {
    this.codeContext = 5
    this._filterHeaders = ['cookie', 'connection']
    this.error = error
    this.request = request
    this.links = []
    this.showAllFrames = false
  }

  /**
   * Returns the source code for a given file. It unable to
   * read file it resolves the promise with a null.
   *
   * @param  {Object} frame
   * @return {Promise}
   */
  _getFrameSource (frame) {
    let path = frame
      .file
      .replace(/dist\/webpack:\//g, '') // unix
      .replace(/dist\\webpack:\\/g, '') // windows

    /**
       * We ignore the error when "fileURLToPath" is unable to parse
       * the path, since returning the frame source is an optional
       * thing
       */
    try {
      path = path.startsWith('file:') ? fileURLToPath(path) : path
    } catch {
    }

    return new Promise((resolve) => {
      fs.readFile(path, 'utf-8', (error, contents) => {
        if (error) {
          resolve(null)
          return
        }

        const lines = contents.split(/\r?\n/)
        const lineNumber = frame.line

        resolve({
          pre: lines.slice(
            Math.max(0, lineNumber - (this.codeContext + 1)),
            lineNumber - 1
          ),
          line: lines[lineNumber - 1],
          post: lines.slice(lineNumber, lineNumber + this.codeContext)
        })
      })
    })
  }

  /**
   * Parses the error stack and returns serialized
   * frames out of it.
   *
   * @return {Object}
   */
  _parseError () {
    return new Promise((resolve, reject) => {
      const stack = new StackTracey(this.error)
      Promise.all(
        stack.items.map(async (frame) => {
          if (this._isNode(frame)) {
            return Promise.resolve(frame)
          }
          return this._getFrameSource(frame).then((context) => {
            frame.context = context
            return frame
          })
        })
      )
        .then(resolve)
        .catch(reject)
    })
  }

  /**
   * Returns the context with code for a given
   * frame.
   *
   * @param  {Object}
   * @return {Object}
   */
  _getContext (frame) {
    if (!frame.context) {
      return {}
    }

    return {
      start: frame.line - (frame.context.pre || []).length,
      pre: frame.context.pre.join('\n'),
      line: frame.context.line,
      post: frame.context.post.join('\n')
    }
  }

  /**
   * Returns classes to be used inside HTML when
   * displaying the frames list.
   *
   * @param  {Object}
   * @param  {Number}
   *
   * @return {String}
   */
  _getDisplayClasses (frame, index) {
    const classes = []
    if (index === 0) {
      classes.push('active')
    }

    classes.push(
      frame.isApp
        ? 'app-frame'
        : 'native-frame'
    )

    return classes.join(' ')
  }

  /**
   * Compiles the view using HTML
   *
   * @param  {String}
   * @param  {Object}
   *
   * @return {String}
   */
  _compileView (view, data) {
    return Mustache.render(view, data)
  }

  /**
   * Serializes frame to a usable error object.
   *
   * @param  {Object}
   *
   * @return {Object}
   */
  _serializeFrame (frame) {
    return {
      file: frame.fileRelative,
      filePath: frame.file.startsWith('file:') ? fileURLToPath(frame.file) : frame.file,
      line: frame.line,
      callee: frame.callee,
      calleeShort: frame.calleeShort,
      column: frame.column,
      context: this._getContext(frame),
      isModule: frame.thirdParty,
      isNative: frame.native,
      isApp: this._isApp(frame)
    }
  }

  /**
   * Returns whether frame belongs to nodejs
   * or not.
   *
   * @return {Boolean} [description]
   */
  _isNode (frame) {
    if (frame.native) {
      return true
    }

    const filename = frame.file || ''
    if (filename.startsWith('node:')) {
      return true
    }
    return false

    // return !path.isAbsolute(filename) && filename[0] !== '.'
  }

  /**
   * Returns whether code belongs to the app
   * or not.
   *
   * @return {Boolean} [description]
   */
  _isApp (frame) {
    return !this._isNode(frame) && !this._isNodeModule(frame)
  }

  /**
   * Returns whether frame belongs to a node_module or
   * not
   *
   * @method _isNodeModule
   *
   * @param  {Object}      frame
   *
   * @return {Boolean}
   *
   * @private
   */
  _isNodeModule (frame) {
    return (frame.file || '').indexOf('node_modules' + path.sep) > -1
  }

  /**
   * Serializes stack to Mustache friendly object to
   * be used within the view. Optionally can pass
   * a callback to customize the frames output.
   *
   * @param  {Object}
   * @param  {Function} [callback]
   *
   * @return {Object}
   */
  _serializeData (stack, callback) {
    callback = callback || this._serializeFrame.bind(this)

    const frames = stack instanceof Array === true
      ? stack.filter((frame) => frame.file).map(callback)
      : []

    if (frames.length > 0) {
      if (frames.find(frame => frame.classes)) {
        const firstAppFrame = frames.findIndex(frame => frame.isApp)
        if (firstAppFrame !== -1) {
          // If the firstAppFrame is not -1 it means we have an app frame in the
          // stack. So we'll remove 'active' from the class list of the first
          // frame and add it to the class list of the app frame.
          const firstFrameClasses = frames[0].classes.split(' ')
          firstFrameClasses.splice(firstFrameClasses.indexOf('active'), 1)
          frames[0].classes = firstFrameClasses.join(' ')

          frames[firstAppFrame].classes += ' active'
        }
      }
    }

    return {
      message: this.error.message,
      name: this.error.name,
      status: this.error.status,
      frames
    }
  }

  /**
   * Returns a serialized object with important
   * information.
   *
   * @return {Object}
   */
  _serializeRequest () {
    const headers = []

    Object.keys(this.request.headers).forEach((key) => {
      if (this._filterHeaders.indexOf(key) > -1) {
        return
      }
      headers.push({
        key: key.toUpperCase(),
        value: this.request.headers[key]
      })
    })

    const parsedCookies = cookie.parse(this.request.headers.cookie || '')
    const cookies = Object.keys(parsedCookies).map((key) => {
      return { key, value: parsedCookies[key] }
    })

    return {
      url: this.request.url,
      httpVersion: this.request.httpVersion,
      method: this.request.method,
      connection: this.request.headers.connection,
      headers: headers,
      cookies: cookies
    }
  }

  /**
   * Stores the link `callback` which
   * will be processed when rendering
   * the HTML view.
   *
   * @param {Function} callback
   *
   * @returns {Object}
   */
  addLink (callback) {
    if (typeof callback === 'function') {
      this.links.push(callback)
      return this
    }

    throw new Error('Pass a callback function to "addLink"')
  }

  /**
   * Toggle the state of showing all frames by default
   */
  toggleShowAllFrames () {
    this.showAllFrames = !this.showAllFrames
    return this
  }

  /**
   * Returns error stack as JSON.
   *
   * @return {Promise}
   */
  toJSON () {
    return new Promise((resolve, reject) => {
      this._parseError()
        .then((stack) => {
          resolve({
            error: this._serializeData(stack)
          })
        })
        .catch(reject)
    })
  }

  /**
   * Returns HTML representation of the error stack
   * by parsing the stack into frames and getting
   * important info out of it.
   *
   * @return {Promise}
   */
  toHTML () {
    return new Promise((resolve, reject) => {
      this._parseError()
        .then((stack) => {
          const data = this._serializeData(stack, (frame, index) => {
            const serializedFrame = this._serializeFrame(frame)

            serializedFrame.classes = this._getDisplayClasses(
              serializedFrame,
              index
            )

            return serializedFrame
          })

          if (this.request) {
            data.request = this._serializeRequest()
          }

          const rawMessage = data.message.trim().split('\n')
          data.message = rawMessage.map(rawLine => {
            if (rawLine.startsWith('>\t')) {
              rawLine = { code: rawLine.substring(2, rawLine.length) }
            } else {
              rawLine = { text: rawLine }
            }

            return rawLine
          })

          if (this.error.explaination) { data.explaination = this.error.explaination }

          data.links = this.links.map((renderLink) => renderLink(data))
          data.loadFA = !!data.links.find((link) => link.includes('fa-'))
          data.showAllFrames = this.showAllFrames

          return resolve(this._compileView(viewTemplate, data))
        })
        .catch(reject)
    })
  }
}

module.exports = Youch
