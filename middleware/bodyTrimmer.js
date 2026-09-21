const bodyTrimmer = (req, res, next) => {
  try {
    for (const key in req.body) {
      if (typeof req.body[key] === 'string') {
        req.body[key] = req.body[key].trim()
      }
    }
    next()
  } catch (err) {
    return res.status(500).json({ msg: err.message })
  }
}

module.exports = bodyTrimmer
