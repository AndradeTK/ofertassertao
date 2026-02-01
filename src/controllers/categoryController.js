const Category = require('../models/categoryModel');

exports.renderDashboard = async (req, res) => {
    try {
        const categories = await Category.getAll();
        res.render('index', { categories });
    } catch (err) {
        res.status(500).send("Erro ao carregar dashboard");
    }
};

exports.addCategory = async (req, res) => {
    const { name_ia, thread_id } = req.body;
    try {
        await Category.create(name_ia, thread_id);
        res.redirect('/');
    } catch (err) {
        res.status(500).send("Erro ao salvar categoria");
    }
};

exports.removeCategory = async (req, res) => {
    try {
        await Category.delete(req.params.id);
        res.redirect('/');
    } catch (err) {
        res.status(500).send("Erro ao deletar");
    }
};