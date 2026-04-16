function requireAuth(req, res, next) {
  if (!req.session.user) {
    req.flash("error", "Please log in first.");
    return res.redirect("/login");
  }
  next();
}

function requireRole(roles = []) {
  return function (req, res, next) {
    if (!req.session.user) {
      req.flash("error", "Please log in first.");
      return res.redirect("/login");
    }
    if (!roles.includes(req.session.user.role)) {
      req.flash("error", "You do not have access to that page.");
      return res.redirect("/dashboard");
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
