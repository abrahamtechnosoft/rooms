const router = require('express').Router();
const ctrl = require('../controllers/userController');
const authMiddleware = require('../middlewares/authMiddleware');
const { requireRole } = require('../middlewares/roleMiddleware');

// Endpoint disponible para cualquier usuario autenticado: lo usa el picker de
// colaboradores en el formulario de reservas.
router.get('/picker', authMiddleware, ctrl.picker);

// Foto de perfil del usuario autenticado (cualquier rol).
router.post('/me/avatar', authMiddleware, ctrl.uploadAvatar);
router.delete('/me/avatar', authMiddleware, ctrl.deleteAvatar);

// Onboarding: marcar que el usuario ya vio la oferta de subir foto.
router.post(
  '/me/dismiss-avatar-prompt',
  authMiddleware,
  ctrl.dismissAvatarPrompt
);

// Preferencias de notificación por correo (cualquier rol, sobre sí mismo).
router.get(
  '/me/notification-preferences',
  authMiddleware,
  ctrl.getNotificationPreferences
);
router.put(
  '/me/notification-preferences',
  authMiddleware,
  ctrl.updateNotificationPreferences
);

// Resto de endpoints solo para administradores.
router.use(authMiddleware, requireRole('admin'));

router.get('/', ctrl.listUsers);
router.post('/', ctrl.createUser);
router.patch('/:id/active', ctrl.setActive);
router.patch('/:id/department', ctrl.updateUserDepartment);
router.patch('/:id', ctrl.updateUser);

module.exports = router;
